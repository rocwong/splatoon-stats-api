/** @typedef {import('..').AsyncRouteHandler} AsyncRouteHandler */

const fs = require('fs');
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const moment = require('moment-timezone');
const Sentry = require('@sentry/node');
const Tracing = require('@sentry/tracing');

const Cache = require('./cache');
const config = require('../config');
const { db } = require('./db');
const {
  calculateStartTimeFromLeagueDate,
  dateToSqlTimestamp,
  escapeLikeQuery,
  getWeaponClassById,
  range,
  wrapPromise,
} = require('./util');
const { groupTypes, findRuleId, rankedRules, rankedRuleIds, getOriginalWeaponId } = require('./data');
const {
  joinLatestName,
  queryLatestXRankingStartTime,
  queryLeagueWeaponRuleRecords,
  queryLeagueWeaponsRuleRecords,
  queryWeaponRanking,
  queryWeaponUsageDifference,
  queryWeaponTopPlayers,
  queryXWeaponRuleRecords,
  queryXWeaponRuleRecordsCount,
  getWeaponIds,
  getKnownNames,
  queryPlayerRankingRecords,
} = require('./query');

const app = express();
app.disable('x-powered-by');

if (config.SENTRY_DSN) {
  console.log('Sentry is enabled for logging.');

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    integrations: [new Sentry.Integrations.Http({ tracing: true }), new Tracing.Integrations.Express({ app })],

    tracesSampler(context) {
      if (context.parentSampled) {
        return context.parentSampled;
      }

      const url = new URL(context.request.url);
      if (url.pathname.startsWith('/static')) {
        return 0;
      }

      return config.SENTRY_TRACE_SAMPLE_RATE;
    },
  });

  app.use(Sentry.Handlers.requestHandler());
  if (process.env.NODE_ENV === 'production') {
    app.use(Sentry.Handlers.tracingHandler());
  }
}

app.use(
  cors(
    process.env.NODE_ENV === 'development'
      ? undefined
      : {
          origin: config.FRONTEND_ORIGIN,
        },
  ),
);

app.use((req, res, next) => {
  if (req.method === 'GET' && config.GET_REQUEST_CACHE_DURATION) {
    res.setHeader('cache-control', `public, s-maxage=${config.GET_REQUEST_CACHE_DURATION}`);
  }

  next();
});

// Logging middleware
const logFormat = process.env.NODE_ENV === 'development' ? 'dev' : 'short';
app.use(morgan(logFormat));

// Serve static files
app.use('/static', express.static('cache'));

// V2 only endpoints
app.use('/v2', require('./v2-api'));

app.get('/', (req, res) => {
  res.send('It works.');
});

app.get(
  '/data',
  wrapPromise(async (req, res) => {
    const rows = await db
      .select('weapon_id', db.raw('main_reference != weapon_id as is_variant'))
      .from('weapons')
      .whereNull('reskin_of')
      .orderBy('weapon_id');
    const weapons = rows.map((w) => ({
      ...w,
      class: getWeaponClassById(w.weapon_id),
    }));

    res.json({
      weapons,
    });
  }),
);

app.get(
  '/players/:playerId([\\da-f]{16})',
  wrapPromise(async (req, res) => {
    const id = req.params.playerId;
    const [names, x, league, splatfest] = await Promise.all([
      getKnownNames(id),
      ...['x', 'league', 'splatfest'].map((rankingType) => queryPlayerRankingRecords(rankingType, id)),
    ]);

    return res.json({
      name: names?.[0]?.player_name ?? null,
      id,
      names,
      rankings: {
        x,
        league,
        splatfest,
      },
    });
  }),
);

app.get(
  '/players/:playerId([\\da-f]{16})/known_names',
  wrapPromise(async (req, res) => {
    const names = await getKnownNames(req.params.playerId);
    res.json(names);
  }),
);

app.get(
  '/players/:playerId([\\da-f]{16})/rankings/:rankingType(league|x|splatfest)',
  wrapPromise(async (req, res) => {
    const { rankingType, playerId } = req.params;
    const rows = await queryPlayerRankingRecords(rankingType, playerId);
    res.json(rows);
  }),
);

app.get(
  '/players/search',
  wrapPromise(async (req, res) => {
    const { name } = req.query;

    const rows = await db
      .with('players', (cte) => {
        cte
          .select(['player_id', 'player_name', 'last_used'])
          .from('player_known_names')
          .where('player_name', 'ilike', `%${escapeLikeQuery(name)}%`)
          .orderBy('last_used', 'desc')
          .orderBy('player_id', 'asc')
          .limit(50);
      })
      .with('player_max_ratings', (cte) => {
        cte
          .select('xr.player_id', db.raw('MAX(xr.rating) as max_x_rating'))
          .from('players')
          .innerJoin({ xr: 'x_rankings' }, 'xr.player_id', 'players.player_id')
          .groupBy('xr.player_id');
      })
      .select('*')
      .from('players')
      .innerJoin({ pmr: 'player_max_ratings' }, 'pmr.player_id', 'players.player_id');
    res.json(rows);
  }),
);

app.get(
  '/rankings/x/:year(\\d{4})/:month([1-9]|1[0-2])/:ruleKey([a-z_]+)',
  wrapPromise(async (req, res) => {
    const { year, month, ruleKey } = req.params;

    const ruleId = findRuleId(ruleKey);
    const startTime = moment.utc({ year, month: month - 1 });

    const rows = await db
      .select(['x_rankings.player_id', 'weapon_id', 'rank', 'rating', 'player_names.player_name'])
      .from('x_rankings')
      .leftOuterJoin(joinLatestName('x_rankings'))
      .where('rule_id', ruleId)
      .whereRaw('start_time = to_timestamp(?)', [startTime.unix()])
      .orderBy('rank', 'asc')
      .orderBy('x_rankings.player_id', 'asc');
    if (!rows.length) {
      res.sendStatus(404);
      return;
    }
    res.json(rows);
  }),
);

// eslint-disable-next-line
app.get(
  '/rankings/league/:leagueDate(\\d{8}):groupType([TP])',
  wrapPromise(async (req, res) => {
    const { leagueDate, groupType } = req.params;

    const startTime = calculateStartTimeFromLeagueDate(leagueDate);

    // Instead of validating, just check if it's a valid date.
    if (Number.isNaN(startTime)) {
      res.status(422).send('Bad league ID.');
      return;
    }

    const result = await db.raw(
      `select
        distinct rank, rating, group_id,
        (select array_agg(array[l2.player_id, l2.weapon_id::varchar, player_names.player_name])
          from league_rankings as l2
          left outer join :joinQuery:
          where l1.group_id = l2.group_id AND start_time = to_timestamp(:startTime)) as group_members
      from league_rankings as l1
      where start_time = to_timestamp(:startTime) AND group_type = :groupType
      order by rank asc`,
      { startTime: startTime / 1000, groupType, joinQuery: joinLatestName('l2') },
    );

    const { rows } = result;
    if (!rows.length) {
      res.sendStatus(404);
      return;
    }
    res.json(result.rows);
  }),
);

app.get(
  '/rankings/splatfest/:region((na|eu|jp))/:splatfestId(\\d+)',
  wrapPromise(async (req, res) => {
    const { region, splatfestId } = req.params;

    const rows = await db
      .select('*')
      .from('splatfest_rankings')
      .leftOuterJoin(joinLatestName('splatfest_rankings'))
      .where({ region, splatfest_id: splatfestId })
      .orderBy('rank', 'asc');
    if (!rows.length) {
      res.sendStatus(404);
      return;
    }
    res.json(rows);
  }),
);

const weaponPopularityRouterCallback = wrapPromise(async (req, res) => {
  const { rankingType, weaponType, year, month, rule, region, splatfestId } = req.params;

  const ruleId = rule ? findRuleId(rule) : 0;

  const startTime = moment.utc({ year, month: month - 1 });
  const startTimestamp = dateToSqlTimestamp(startTime);
  const endTimestamp = dateToSqlTimestamp(startTime.add({ month: 1 }));

  try {
    const rows = await queryWeaponRanking({
      rankingType,
      weaponType,
      startTime: startTimestamp,
      endTime: endTimestamp,
      ruleId,
      region,
      splatfestId,
    });
    if (!rows.length) {
      res.sendStatus(404);
      return;
    }
    res.json(rows);
  } catch (e) {
    res.status(500).send(e);
  }
});

const weaponTrendRouterCallback = wrapPromise(async (req, res) => {
  const { rankingType, weaponType, rule /* region, splatfestId, */ } = req.params;
  const dateFormat = 'YYYY-MM';
  const previousMonth = moment.utc(req.query.previous_month, dateFormat);
  const currentMonth = moment.utc(req.query.current_month, dateFormat);

  if (!(previousMonth.isValid() && currentMonth.isValid() && currentMonth > previousMonth)) {
    res.status(422).send('Invalid date(s).');
    return;
  }

  const ruleId = rule ? findRuleId(rule) : 0;

  try {
    const rows = await queryWeaponUsageDifference({
      rankingType,
      weaponType,
      previousMonth,
      currentMonth,
      ruleId /* region, splatfestId, */,
    });
    if (rows[0].current_month_count === 0) {
      res.sendStatus(404);
      return;
    }
    res.json(rows);
  } catch (e) {
    res.status(500).send(e);
  }
});

const rulesPattern = rankedRules.map((rule) => rule.key).join('|');

app.get(
  '/weapons/:weaponType(weapons|mains|specials|subs)/:rankingType(league|x)/:year(\\d{4})/:month([1-9]|1[012])',
  weaponPopularityRouterCallback,
);
app.get(
  `/weapons/:weaponType(weapons|mains|specials|subs)/:rankingType(league|x)/:year(\\d{4})/:month([1-9]|1[012])/:rule(${rulesPattern})`,
  weaponPopularityRouterCallback,
);
app.get(
  '/weapons/:weaponType(weapons|mains|specials|subs)/:rankingType(splatfest)/:region(na|eu|jp)/:splatfestId(\\d+)',
  weaponPopularityRouterCallback,
);

app.get('/trends/:weaponType(weapons|mains|specials|subs)/:rankingType(x)/', weaponTrendRouterCallback);
app.get(
  `/trends/:weaponType(weapons|mains|specials|subs)/:rankingType(x)/:rule(${rulesPattern})`,
  weaponTrendRouterCallback,
);

app.get(
  '/records',
  wrapPromise(async (req, res) => {
    const latestXRankingTime = await queryLatestXRankingStartTime();
    const cachePath = `cache/weapons-x-top-players.${moment(latestXRankingTime).format('YYYY-MM')}.json`;
    let cacheHit = false;
    let weaponTopPlayers = [];

    if (fs.existsSync(cachePath)) {
      cacheHit = true;
      weaponTopPlayers = JSON.parse(fs.readFileSync(cachePath));
    } else {
      const weaponIds = await getWeaponIds();
      /** @type Array<Array<{ rule_id: number; rating: number; start_time: string; player_name: string; player_id: string; weapon_id: number; }>>> */
      const weaponRecords = (await Promise.all(weaponIds.map(queryWeaponTopPlayers))).filter(Boolean);
      weaponTopPlayers = weaponRecords.map((weapon) => {
        const topPlayers = Object.fromEntries(
          weapon.map((player) => [
            player.rule_id,
            {
              player_id: player.player_id,
              name: player.player_name,
              rating: Number(player.rating),
              start_time: player.start_time,
            },
          ]),
        );

        return {
          weapon_id: getOriginalWeaponId(weapon[0].weapon_id),
          top_players: topPlayers,
        };
      });

      fs.writeFileSync(cachePath, JSON.stringify(weaponTopPlayers));
    }

    const xRankedRatingRecords = await Promise.all(
      rankedRuleIds.map((ruleId) =>
        db
          .select('*')
          .from('x_rankings')
          .leftOuterJoin(joinLatestName('x_rankings'))
          .where('rule_id', ruleId)
          .orderBy('rating', 'desc')
          .orderBy('x_rankings.player_id')
          .limit(30),
      ),
    );

    const leagueRatingRecords = {};
    await Promise.all(
      groupTypes.map(async (groupType) => {
        await Promise.all(
          rankedRuleIds.map(async (ruleId, i) => {
            if (!(groupType.key in leagueRatingRecords)) {
              leagueRatingRecords[groupType.key] = [];
            }

            leagueRatingRecords[groupType.key][i] = (
              await db.raw(
                `
      WITH cte AS (
        SELECT league_rankings.group_type, league_rankings.group_id, league_rankings.player_id, league_rankings.rating, league_rankings.start_time, league_rankings.weapon_id, league_schedules.stage_ids FROM league_rankings
        INNER JOIN league_schedules ON league_rankings.start_time = league_schedules.start_time
        WHERE group_type = :groupType AND rule_id = :ruleId
        ORDER BY rating DESC
        LIMIT :limit
      )
      -- You can't create array consists of different types so it convert weapon_id into varchar
      SELECT cte.group_type, cte.group_id, cte.rating, cte.start_time, cte.stage_ids, array_agg(ARRAY[cte.player_id, weapon_id::varchar, player_names.player_name]) as teammates
      FROM cte
      LEFT OUTER JOIN :joinQuery:
      GROUP BY group_id, group_type, start_time, rating, stage_ids
      ORDER BY rating DESC
    `,
                {
                  groupType: groupType.query,
                  ruleId,
                  joinQuery: joinLatestName('cte'),
                  limit: groupType.members * 30,
                },
              )
            ).rows;
          }),
        );
      }),
    );

    // const monthlyLeagueBattlesRecords = [];
    const monthlyLeagueBattlesRecordsColumns = [
      'monthly_league_battle_schedules.start_time',
      'rating',
      'rule_id',
      'group_type',
    ];
    const monthlyLeagueBattlesRecords = await db
      .select(monthlyLeagueBattlesRecordsColumns)
      .from('monthly_league_battle_schedules')
      .innerJoin('league_schedules', 'monthly_league_battle_schedules.start_time', 'league_schedules.start_time')
      .innerJoin('league_rankings', 'monthly_league_battle_schedules.start_time', 'league_rankings.start_time')
      .where('rank', 1)
      .where('group_type', 'T')
      .groupBy(monthlyLeagueBattlesRecordsColumns)
      .orderBy('start_time', 'desc');

    res.json({
      cacheHit,
      league_rating_records: leagueRatingRecords,
      monthly_league_battles_records: monthlyLeagueBattlesRecords,
      weapons_top_players: weaponTopPlayers,
      x_ranked_rating_records: xRankedRatingRecords,
    });
  }),
);

app.get(
  '/records/league-weapon',
  wrapPromise(async (req, res) => {
    let { group_type: groupType, weapon_id: weaponId, weapon_ids: weaponIds } = req.query;
    weaponId = Number.parseInt(weaponId, 10);
    groupType = groupTypes.find((type) => type.query === groupType) || groupTypes[0];

    if (Number.isNaN(weaponId)) {
      weaponIds = weaponIds.split(',').map((wid) => Number.parseInt(wid, 10));
      if (weaponIds.some(Number.isNaN) || groupType.members !== weaponIds.length) {
        res.status(400).send('Missing required parameter: weaponId / weaponIds.');
        return;
      }
    }

    const promises = rankedRuleIds.map((ruleId) =>
      weaponIds
        ? queryLeagueWeaponsRuleRecords(ruleId, groupType, weaponIds)
        : queryLeagueWeaponRuleRecords(ruleId, groupType, weaponId),
    );
    const records = await Promise.all(promises);

    res.json(Object.fromEntries(records.map((value, i) => [i + 1, value])));
  }),
);

app.get(
  '/records/x-weapon',
  wrapPromise(async (req, res) => {
    let { weapon_id: weaponId } = req.query;
    weaponId = Number.parseInt(weaponId, 10);

    if (Number.isNaN(weaponId)) {
      res.status(400).send('Missing required parameter: weaponId.');
      return;
    }

    const promises = [0, ...rankedRuleIds].map(async (ruleId) => {
      const count = await queryXWeaponRuleRecordsCount(ruleId, weaponId);
      const records = await queryXWeaponRuleRecords(ruleId, weaponId);

      return {
        count,
        records,
      };
    });
    const records = await Promise.all(promises);

    res.json(Object.fromEntries(records.map((value, i) => [i, value])));
  }),
);

app.get(
  '/splatfests',
  wrapPromise(async (req, res) => {
    const rows = await db
      .select('*')
      .from('splatfest_schedules')
      .where('start_time', '<', 'now()')
      .orderBy('start_time', 'desc');
    res.json(rows);
  }),
);

app.get(
  '/stats',
  wrapPromise(async (req, res) => {
    const result = await db.raw(`
    select
        (select count(distinct(start_time)) from x_rankings) as x_rankings,
        (select reltuples::bigint from pg_class where relname='league_rankings') as league_rankings_estimate,
        (select count(*) from splatfest_schedules) as splatfests`);
    res.json(result.rows[0]);
  }),
);

app.get(
  '/distributions/x',
  wrapPromise(async (req, res) => {
    const cache = await Cache.wrap(Cache.keys.distributions_x, async () => {
      const start = 2600;
      const end = 3100;
      const interval = 10;
      const classes = range(start, end, interval);
      const classesQuery = classes
        .map((rating) => {
          return `SUM(CASE WHEN rating >= ${rating} THEN 1 ELSE 0 END) AS over${rating}`;
        })
        .join(',');
      const query = `
      WITH cte AS (
        SELECT MAX(rating) AS rating, rule_id
        FROM x_rankings
        GROUP BY player_id, rule_id
      )
      SELECT
        COUNT(*) AS count,
        rule_id,
        ${classesQuery}
        FROM cte
        GROUP by rule_id
      `;
      const { rows } = await db.raw(query);
      const data = {};
      rows.forEach((row) => {
        Object.entries(row).forEach(([key, value]) => {
          if (!data[row.rule_id]) {
            data[row.rule_id] = {
              count: row.count,
              distributions: {},
            };
          }

          if (key.startsWith('over')) {
            data[row.rule_id].distributions[key.replace('over', '')] = value;
          }
        });
      });

      return data;
    }, { ttl: 86400 });

    res.json(cache);
  }),
);

app.get(
  '/distributions/league',
  wrapPromise(async (req, res) => {
    const cache = await Cache.wrap(Cache.keys.distributions_league, async () => {
      const start = 2200;
      const end = 2900;
      const interval = 20;
      const classes = range(start, end, interval);
      const classesQuery = classes
        .map((rating) => {
          return `SUM(CASE WHEN rating >= ${rating} THEN 1 ELSE 0 END) AS over${rating}`;
        })
        .join(',');

      const [team, pair] = await Promise.all(
        groupTypes.map(async ({ query: queryKey }) => {
          const query = `
          WITH cte AS (
            SELECT MAX(rating) AS rating, rule_id
            FROM league_rankings lr
            INNER JOIN league_schedules ls ON lr.start_time = ls.start_time
            WHERE group_type = '${queryKey}'
            GROUP BY player_id, rule_id
          )
          SELECT
            COUNT(*) AS count,
            rule_id,
            ${classesQuery}
            FROM cte
            GROUP by rule_id
          `;
          const { rows } = await db.raw(query);
          const data = {};
          rows.forEach((row) => {
            Object.entries(row).forEach(([key, value]) => {
              if (!data[row.rule_id]) {
                data[row.rule_id] = {
                  count: row.count,
                  distributions: {},
                };
              }

              if (key.startsWith('over')) {
                data[row.rule_id].distributions[key.replace('over', '')] = value;
              }
            });
          });

          return data;
        }),
      );

      return {
        team,
        pair,
      };
    }, { ttl: 86400 });

    res.json(cache);
  }),
);

module.exports = app;
