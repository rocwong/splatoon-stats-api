const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const config = require('../config');
const { db } = require('./db');
const { calculateStartTimeFromLeagueDate } = require('./util');

const app = express();

app.use(cors({
  origin: config.FRONTEND_ORIGIN,
}));

// Logging middleware
const logFormat = process.env.NODE_ENV === 'development' ? 'dev' : 'short';
app.use(morgan(logFormat));

// Serve static files
app.use('/static', express.static('cache'));

app.get('/', (req, res) => {
  res.send('It works.');
});

app.get('/league/players/:playerId([\\da-f]{16})', (req, res) => {
  const { playerId } = req.params;

  db
    .select('*')
    .from('league_rankings')
    .where('player_id', playerId)
    .orderBy('league_rankings.start_time', 'asc')
    .join('league_schedules', 'league_rankings.start_time', '=', 'league_schedules.start_time')
    .then((rows) => {
      res.json(rows);
    });
});

// eslint-disable-next-line consistent-return
app.get('/league/rankings/:leagueDate(\\d{8}):groupType([TP])', (req, res) => {
  const { leagueDate, groupType } = req.params;

  const startTime = calculateStartTimeFromLeagueDate(leagueDate);

  // Instead of validating, just check if it's a valid date.
  if (Number.isNaN(startTime)) {
    return res.status(422).send('Bad league ID.');
  }

  db
    .select('*')
    .from('league_rankings')
    .whereRaw('start_time = to_timestamp(?) AND group_type = ?', [startTime / 1000, groupType])
    .orderBy('rank', 'asc')
    .orderBy('player_id', 'asc')
    .then((rows) => {
      res.json(rows);
    });
});

app.get('/league/:type((weapons|specials|subs))/:year(\\d{4})/:month([1-9]|1[012])', (req, res) => {
  const { type, year, month } = req.params;

  if (type === 'weapons') {
    db.raw(`
select
    RANK() over (order by popular_weapons.count desc),
    count,
    popular_weapons.temp_weapon_id as weapon_id,
    sub_weapon_id,
    special_weapon_id,
    100 * count / sum(count) over () as percentage
  from (
    select
        -- Group identical weapons (e.g. Hero Shot Replica and Splattershot)
        case
          when weapons.reskin_of is NOT NULL then weapons.reskin_of
          else league_rankings.weapon_id
        end as temp_weapon_id,
        count(league_rankings.weapon_id),
        sub_weapon_id,
        special_weapon_id
    from league_rankings
      inner join weapons on league_rankings.weapon_id = weapons.weapon_id
      where extract(year from start_time) = ?
        AND extract(month from start_time) = ?
      group by temp_weapon_id, sub_weapon_id, special_weapon_id
      order by count desc, temp_weapon_id desc
  ) as popular_weapons
        `, [year, month])
      .then((result) => {
        res.json(result.rows);
      });
  } else if (type === 'specials' || type === 'subs') {
    // e.g.) specials -> special_weapon_id
    const columnName = `${type.substring(0, type.length - 1)}_weapon_id`;
    db.raw(`
select
    rank() over (order by popular_weapons.count desc),
    ${columnName},
    count,
    100 * count / sum(count) over () as percentage
  from (
    select count(weapons.${columnName}), weapons.${columnName} from league_rankings
      inner join weapons on league_rankings.weapon_id = weapons.weapon_id
      where extract(year from start_time) = ?
        AND extract(month from start_time) = ?
      group by weapons.${columnName}
        order by count desc, weapons.${columnName} desc
  ) as popular_weapons
      `, [month, year])
      .then((result) => {
        res.json(result.rows);
      });
  } else { // Theoretically this block is unreachable.
    res.status(422).send('Bad type');
  }
});

module.exports = app;
