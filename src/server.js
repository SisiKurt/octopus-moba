// Минимальный MOBA-прототип: 2 базы, коридоры, мобы, 3 героя, оружие.
// Всё на сервере, клиент только рисует то, что прислал сервер.

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3001;
const TICK_MS = 50;            // 20 тиков/сек
const MAP_W = 480;                 // ширина карты (мобильный портрет, ~9:16)
const MAP_H = Math.round(MAP_W * 16 / 9);  // 480 × 16/9 = 854 — высота карты

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ---------- Каталог оружия ----------
// Баланс Battle Tanks формула: dps_value = (4 * cost * cooldown) / (0.06 * range)
// Урон подобран так, чтобы DPS у всех оружий был примерно одинаковый при заданной цене/кулдауне/радиусе.
// (Т.е. более дальнее = меньше DPS за слот, более частое = меньше урон за выстрел — игрок выбирает стиль.)
// shotgunspecial: выпускает 3 снаряда (урон делится на 3, считаем выстрелов 3 за cooldown).
const WEAPONS = {
  pistol:   { name: 'Pistol',   range: 120, cooldown: 10, dmg: 8,   projSpeed: 8,  price: 0   },
  shotgun:  { name: 'Shotgun',  range: 80,  cooldown: 22, dmgPerPellet: 4, pellets: 3, projSpeed: 7,  price: 80  }, // дробь ×3 снаряда
  rifle:    { name: 'Rifle',    range: 240, cooldown: 14, dmg: 12,  projSpeed: 14, price: 120 },
  smg:      { name: 'SMG',      range: 110, cooldown: 4,  dmg: 4,   projSpeed: 12, price: 100 },
  cannon:   { name: 'Cannon',   range: 90,  cooldown: 30, dmg: 32,  projSpeed: 6,  price: 200, isCannon: true }, // AoE
  molotov:  { name: 'Molotov',  range: 200, cooldown: 20, dmg: 22,  projSpeed: 5,  price: 150, isCannon: true, aoeRadius: 60 }, // AoE по области
};

// автобаланс-проверка (в консоль при старте)
for (const [k, w] of Object.entries(WEAPONS)) {
  const dmg = w.dmg ?? (w.dmgPerPellet * (w.pellets || 1));
  // значение "стоимости" по Battle Tanks формуле (меньше = более выгодно)
  const val = (4 * w.price * w.cooldown) / (0.06 * (w.range || 1));
  console.log(`  ${k.padEnd(8)} | dmg ${String(dmg).padStart(3)} | cd ${String(w.cooldown).padStart(2)} | range ${String(w.range).padStart(3)} | price ${String(w.price).padStart(3)} | val ${val.toFixed(0)}`);
}

// ---------- Герои ----------
const HERO_DEFS = {
  agile: { name: 'Ловкач', color: '#22dd66', shape: 'square',
    baseStats: { hp: 110, hpReg: 1.5, speed: 3.2, armor: 1 },
    passivePerLevel: { hp: 6, dmg: 1.5, speed: 0.15 } },
  tank: { name: 'Танк', color: '#4488ff', shape: 'square',
    baseStats: { hp: 200, hpReg: 1.0, speed: 2.4, armor: 5 },
    passivePerLevel: { hp: 18, armor: 1.2 } },
  miner: { name: 'Минёр', color: '#cc44ff', shape: 'square',
    baseStats: { hp: 95, hpReg: 1.2, speed: 2.8, armor: 1 },
    passivePerLevel: { hp: 5, dmg: 2.0 } },
};

// ---------- Мир ----------
function createWorld() {
  return {
    tick: 0,
    mapW: MAP_W,
    mapH: MAP_H,
    bases: [
      // blue (твоя) — снизу по центру, красная — сверху
      { id: 'blue',  x: MAP_W/2, y: MAP_H-80, hp: 500, maxHp: 500, owner: 'blue'  },
      { id: 'red',   x: MAP_W/2, y: 80,      hp: 500, maxHp: 500, owner: 'red' },
    ],
    // магазин — рядом с твоей базой (снизу по центру, чуть левее)
    shop: { x: MAP_W/2 - 120, y: MAP_H - 80 },
    lanes: {
      // 2 вертикальных коридора (left / right), mid убран
      left:  { x: MAP_W * 0.33, mobs: [] },
      right: { x: MAP_W * 0.67, mobs: [] },
    },
    players: new Map(), // socket.id -> player
    bots: [],           // боты-осьминоги: [{id, ...player-like, state, ...}]
    projectiles: [],
    nextId: 1,
    // счётчик спавнов per (lane,team) — для прогрессии сложности крипов
    spawnCounter: {},   // {"left:blue": 1, "left:red": 2, ...}
    matchStartTime: Date.now(),  // для таймера матча
  };
}

const world = createWorld();

// helper: выбрать X в одном из 2 коридоров (НЕ в стене)
function pickLaneX() {
  return (Math.random() < 0.5 ? world.lanes.left.x : world.lanes.right.x) + (Math.random()-0.5)*20;
}

// ---------- Центральная стена (непроходимая, риф) ----------
// Стена В ЦЕНТРЕ КАРТЫ: x ∈ [MAP_W/2 - WALL_W, MAP_W/2 + WALL_W], но НЕ на всю высоту!
// Только средняя треть по Y: [WALL_Y_TOP, WALL_Y_BOT]
// Сверху и снизу — открытые проходы, герой может перейти из одного коридора в другой
const WALL_W = 22; // ширина стены (половина), согласовано с клиентом
const WALL_Y_TOP = MAP_H / 2 - 130;   // верхний конец стены (выход к красной)
const WALL_Y_BOT = MAP_H / 2 + 130;   // нижний конец стены (выход к синей)
function blockCentralWall(x, y, radius) {
  // стена существует только между WALL_Y_TOP и WALL_Y_BOT (центр карты)
  if (y > WALL_Y_TOP - radius && y < WALL_Y_BOT + radius) {
    const wx1 = MAP_W / 2 - WALL_W - radius;
    const wx2 = MAP_W / 2 + WALL_W + radius;
    if (x > wx1 && x < wx2) {
      // смотрим какая сторона ближе
      const distLeft  = x - wx1;
      const distRight = wx2 - x;
      x = (distLeft < distRight) ? wx1 : wx2;
    }
  }
  return [x, y];
}

// ---------- Игрок ----------
function newPlayer(socketId, heroKey) {
  const def = HERO_DEFS[heroKey];
  const id = world.nextId++;
  return {
    id, socketId,
    hero: heroKey,
    name: def.name,
    color: def.color,
    shape: def.shape,
    team: 'blue',                 // MVP: все в blue, потом разделим
    // старт у синей базы (снизу по центру)
    // старт у синей базы — выбираем один из 2-х коридоров (left или right), чтобы НЕ ЗАСТРЯТЬ в стене
    x: (Math.random() < 0.5 ? world.lanes.left.x : world.lanes.right.x) + (Math.random()-0.5)*20,
    y: MAP_H - 100,
    hp: def.baseStats.hp,
    maxHp: def.baseStats.hp,
    speed: def.baseStats.speed,
    armor: def.baseStats.armor,
    dmgBonus: 0,
    gold: 0,
    inventory: ['pistol'],                 // массив стволов, до 6 штук
    weaponCooldowns: { pistol: 0 },        // свой кулдаун на каждый ствол
    weaponMerge: { pistol: 1 },            // счётчик копий каждого ствола (мерж при >=2)
    level: 1,
    xp: 0,
    xpNext: 30,
    skillLevels: [0,0,0,0,0,0],   // 6 слотов
    cooldown: 0,
    targetAngle: 0,
  };
}

// ---------- Бот-осьминог ----------
// Структура похожа на игрока, но без socketId. ИИ тикает в tick().
function newBot(heroKey, team) {
  const def = HERO_DEFS[heroKey];
  return {
    id: world.nextId++,
    isBot: true,
    hero: heroKey,
    name: def.name + '-bot',
    color: def.color,
    shape: def.shape,
    team,
    x: pickLaneX(),
    y: team === 'red' ? 100 : MAP_H - 130,
    hp: def.baseStats.hp, maxHp: def.baseStats.hp,
    speed: def.baseStats.speed * 0.85,  // бот чуть медленнее
    armor: def.baseStats.armor,
    dmgBonus: 0,
    gold: 30,
    inventory: ['pistol'],
    weaponCooldowns: { pistol: 0 },
    weaponMerge: { pistol: 1 },
    level: 1, xp: 0, xpNext: 30, skillLevels: [0,0,0,0,0,0],
    cooldown: 0, targetAngle: -Math.PI/2,  // смотрит вверх (к врагу)
    // AI-специфика
    state: 'FARM',          // FARM / FIGHT / RETREAT / SHOP
    stateTimer: 0,
    targetX: MAP_W/2, targetY: MAP_H/2,  // куда идём
    aiCooldown: 0,
  };
}

function spawnInitialBots() {
  // 2 бота у красной базы, один у синей (как союзник)
  world.bots.push(newBot('tank',    'red'));
  world.bots.push(newBot('agile',   'red'));
  world.bots.push(newBot('miner',   'blue'));
}

function recomputeStats(p) {
  const def = HERO_DEFS[p.hero];
  let hp = def.baseStats.hp;
  let armor = def.baseStats.armor;
  let dmg = 0;
  let speed = def.baseStats.speed;
  const perks = def.passivePerLevel;
  const totalLevels = p.skillLevels.reduce((a,b)=>a+b, 0);
  if (perks.hp)    hp    += perks.hp    * totalLevels;
  if (perks.armor) armor += perks.armor * totalLevels;
  if (perks.dmg)   dmg   += perks.dmg   * totalLevels;
  if (perks.speed) speed += perks.speed * totalLevels;
  const lv = p.level - 1;
  hp    += 10 * lv;
  armor += 0.3 * lv;
  speed += 0.05 * lv;
  p.maxHp = hp;
  p.armor = armor;
  p.dmgBonus = dmg;
  p.speed = speed;
  if (p.hp > p.maxHp) p.hp = p.maxHp;
}

// ---------- Мобы ----------
// Крип идёт по своему коридору от своей базы к вражеской, тип фиксирован при первом спавне (чередование tank/range)
// Прогрессия: каждый НОВЫЙ спавн = +1 к HP/armor/dmg (статичный рост со временем, не зависит от убийств)
function spawnMob(laneName, team, kills = 0, variant = null) {
  const lane = world.lanes[laneName];
  // red спавнятся у своей базы (сверху) и идут вниз к синей
  // blue спавнятся у своей базы (снизу) и идут вверх к красной
  const ownBaseY = team === 'blue' ? MAP_H - 80 : 80;
  // тип: чередуем tank и range по умолчанию
  if (variant === null) variant = kills % 2;  // 0 = tank, 1 = range
  // прогрессия: +1 к базовым HP/armor/dmg за КАЖДЫЙ новый спавн (а не за убийства)
  // используем world.spawnCounter[(lane,team)] который инкрементируется при КАЖДОМ спавне
  const spawnKey = `${laneName}:${team}`;
  world.spawnCounter[spawnKey] = (world.spawnCounter[spawnKey] || 0) + 1;
  const spawnNum = world.spawnCounter[spawnKey];  // N-ый спавн на этом lane/team
  const hpBonus = (spawnNum - 1);       // первый спавн = +0, второй = +1, ...
  const armorBonus = Math.floor((spawnNum - 1) * 0.5);  // каждый 2-й = +1 armor
  const dmgBonus = spawnNum - 1;        // +1 dmg каждый спавн
  // tank и range базовые статы
  const tankBase  = { hp: 60, armor: 2, dmg: 6,  range: 18, speed: 0.7, size: 10 };
  const rangeBase = { hp: 24, armor: 0, dmg: 4,  range: 80, speed: 0.9, size: 8  };
  const base = (variant === 1) ? rangeBase : tankBase;
  // цвет по команде, тип рисуется обводкой (range - жёлтая)
  const color = team === 'blue' ? '#3399ff' : '#ff5544';
  return {
    id: world.nextId++,
    team,
    shape: 'circle',
    color,
    variant,                          // 0 = tank, 1 = range
    spawnNum,                         // N-ый спавн (для UI)
    x: lane.x + (Math.random()-0.5)*30,
    y: ownBaseY + (team === 'blue' ? -30 : 30),
    hp: base.hp + hpBonus,
    maxHp: base.hp + hpBonus,
    armor: base.armor + armorBonus,
    dmg: base.dmg + dmgBonus,
    range: base.range,
    speed: base.speed,
    size: base.size,
    cooldown: 0,
    lane: laneName,
    target: null,
    // facing для морского конька (1=range) — куда он смотрит
    // 0 = спавн-направление = к вражеской базе, red идут вниз (PI/2), blue вверх (-PI/2)
    facing: team === 'blue' ? -Math.PI/2 : Math.PI/2,
  };
}

// ---------- Снаряды ----------
function spawnProjectile(owner, target, weapon) {
  const dx = target.x - owner.x;
  const dy = target.y - owner.y;
  const ang = Math.atan2(dy, dx);
  return {
    id: world.nextId++,
    ownerId: owner.id,
    x: owner.x, y: owner.y,
    vx: Math.cos(ang) * weapon.projSpeed,
    vy: Math.sin(ang) * weapon.projSpeed,
    dmg: weapon.dmg + (owner.dmgBonus || 0),
    range: weapon.range,
    traveled: 0,
    isCannon: weapon === WEAPONS.cannon,
  };
}

// helper
const allMobs = () => Object.values(world.lanes).flatMap(l => l.mobs);

// ---------- Тик ----------
function tick() {
  world.tick++;

  // ---------- Мобы: AI и респаун ----------
  // На каждую команду в каждом lane — ровно 1 крип. Если умер — респаун с +1% статами.
  // Важно: сначала ищем умерших, удаляем, и в конце спавним новых (чтобы не было >1 моба в lane).
  const mobsToRemove = []; // [{laneName, team, kills}]
  for (const laneName of Object.keys(world.lanes)) {
    const mobs = world.lanes[laneName].mobs;
    for (let i = mobs.length - 1; i >= 0; i--) {
      const m = mobs[i];

      // ---------- AI: приоритеты ----------
      // (1) вражеский крип (range tank) в своём lane в радиусе 220
      // (2) вражеский герой / бот в радиусе 220
      // (3) если ничего — идём к вражеской базе
      let target = null;
      let targetPriority = 0;
      const SENSE_R = 220;

      // (1) крип противника в этом lane или в любом lane (радиус 220)
      for (const ln of Object.keys(world.lanes)) {
        for (const om of world.lanes[ln].mobs) {
          if (om === m || om.team === m.team) continue;
          const d = Math.hypot(om.x - m.x, om.y - m.y);
          if (d < SENSE_R) { target = om; targetPriority = 1; break; }
        }
        if (target) break;
      }

      // (2) если вражеского крипа нет — ближайший вражеский герой/бот (игрок + бот, оба противника)
      if (!target) {
        let nearestEnemy = null, nearestDist = SENSE_R;
        // игроки
        for (const p of world.players.values()) {
          if (p.team === m.team) continue;
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (d < nearestDist) { nearestEnemy = p; nearestDist = d; }
        }
        // боты (наши)
        for (const b of world.bots) {
          if (b.team === m.team || b.hp <= 0) continue;
          const d = Math.hypot(b.x - m.x, b.y - m.y);
          if (d < nearestDist) { nearestEnemy = b; nearestDist = d; }
        }
        if (nearestEnemy) { target = nearestEnemy; targetPriority = 2; }
      }

      // (3) если ничего нет рядом — идём к вражеской базе (по умолчанию)
      const goal = target || world.bases.find(b => b.owner !== m.team);
      const dx = goal.x - m.x;
      const dy = goal.y - m.y;
      const d = Math.hypot(dx, dy);
      if (d > m.range) {
        let nx = m.x + (dx/d) * m.speed;
        let ny = m.y + (dy/d) * m.speed;
        [nx, ny] = blockCentralWall(nx, ny, 8);
        m.x = nx; m.y = ny;
        // facing: морские коньки смотрят в направлении движения (моб)
        if (m.variant === 1) m.facing = Math.atan2(dy, dx);
      }
      // атака
      if (d <= m.range && m.cooldown <= 0) {
        m.cooldown = 30;
        const dmgDealt = Math.max(1, m.dmg - (goal.armor || 0));
        goal.hp -= dmgDealt;
        // facing морского конька — на цель при атаке
        if (m.variant === 1) m.facing = Math.atan2(dy, dx);
        // респаун только героев (у базы нет .hero)
        if (goal.hero && goal.hp <= 0) {
          const def = HERO_DEFS[goal.hero];
          goal.hp = def.baseStats.hp;
          goal.x = pickLaneX();
          goal.y = MAP_H - 130;
        }
      }
      if (m.cooldown > 0) m.cooldown--;

      // моб умер → помечаем на респаун с kills+1 и удаляем
      if (m.hp <= 0) {
        const goldReward = 12, xpReward = 8;
        for (const p of world.players.values()) {
          if (p.team !== m.team) {
            const dd = Math.hypot(p.x - m.x, p.y - m.y);
            if (dd < 200) {
              p.gold += goldReward;
              p.xp  += xpReward;
              if (p.xp >= p.xpNext) { p.xp -= p.xpNext; p.level++; p.xpNext = Math.floor(p.xpNext * 1.4); recomputeStats(p); }
            }
          }
        }
        for (const b of world.bots) {
          if (b.team !== m.team && b.hp > 0) {
            const dd = Math.hypot(b.x - m.x, b.y - m.y);
            if (dd < 200) {
              b.gold += goldReward;
              b.xp  += xpReward;
              if (b.xp >= b.xpNext) { b.xp -= b.xpNext; b.level++; b.xpNext = Math.floor(b.xpNext * 1.4); recomputeStats(b); }
            }
          }
        }
        // пометка на респаун: тот же lane, та же команда, kills+1
        mobsToRemove.push({laneName, team: m.team, kills: m.kills + 1, variant: m.variant});
        mobs.splice(i, 1);
      }
    }
  }

  // ---------- Респаун: 1 крип на (lane × team), variant чередуется по kills ----------
  // Сначала гарантируем базовое наличие крипов (4 штуки: 2 lane × 2 команды)
  for (const ln of Object.keys(world.lanes)) {
    for (const t of ['blue', 'red']) {
      const has = world.lanes[ln].mobs.some(m => m.team === t);
      if (!has) {
        // нет моба в (lane,team) — спавним
        // если только что умер (kill+1), используем этот kills чтобы получить variant через % 2
        const dead = mobsToRemove.find(r => r.laneName === ln && r.team === t);
        if (dead) {
          // уже умершего добавим ниже, тут просто placeholder чтобы был 1 крип
          world.lanes[ln].mobs.push(spawnMob(ln, t, dead.kills, dead.kills % 2));
        } else {
          // стартовый крип (kills=0, variant=tank=0)
          world.lanes[ln].mobs.push(spawnMob(ln, t, 0, 0));
        }
      }
    }
  }

  // игроки: тикаем кулдауны каждого ствола в инвентаре
  for (const p of world.players.values()) {
    for (const wKey of Object.keys(p.weaponCooldowns)) {
      if (p.weaponCooldowns[wKey] > 0) p.weaponCooldowns[wKey]--;
    }
    if (p.hp <= 0) continue;     // респаун через 100 тиков
  }

  // мобы: идут к вражеской базе или к ближайшему врагу
  for (const laneName of Object.keys(world.lanes)) {
    const mobs = world.lanes[laneName].mobs;
    for (let i = mobs.length - 1; i >= 0; i--) {
      const m = mobs[i];
      // найти врага в радиусе
      let nearest = null, nearestDist = 200;
      for (const enemy of [...world.players.values(), ...mobs]) {
        if (enemy.team === m.team || enemy === m) continue;
        const d = Math.hypot(enemy.x - m.x, enemy.y - m.y);
        if (d < nearestDist) { nearest = enemy; nearestDist = d; }
      }
      // цель
      const goal = nearest || world.bases.find(b => b.owner !== m.team);
      const dx = goal.x - m.x;
      const dy = goal.y - m.y;
      const d = Math.hypot(dx, dy);
      if (d > m.range) {
        m.x += (dx/d) * m.speed;
        m.y += (dy/d) * m.speed;
      }
      // атака
      if (d <= m.range && m.cooldown <= 0) {
        m.cooldown = 30;
        const dmgDealt = Math.max(1, m.dmg - (goal.armor || 0));
        goal.hp -= dmgDealt;
        // респаун только для героев (у базы нет .hero)
        if (goal.hero && goal.hp <= 0) {
          const def = HERO_DEFS[goal.hero];
          goal.hp = def.baseStats.hp;
          // респаун у синей базы (снизу)
          goal.x = pickLaneX();
          goal.y = MAP_H - 130;
        }
      }
      if (m.cooldown > 0) m.cooldown--;
      // моб умер
      if (m.hp <= 0) {
        // золото ближайшему игроку той же команды, что и убитый моб (наоборот)
        // золото/XP игрокам и ботам той команды, что убила моба
        const goldReward = 12, xpReward = 8;
        for (const p of world.players.values()) {
          if (p.team !== m.team) {
            const dd = Math.hypot(p.x - m.x, p.y - m.y);
            if (dd < 200) {
              p.gold += goldReward;
              p.xp  += xpReward;
              if (p.xp >= p.xpNext) { p.xp -= p.xpNext; p.level++; p.xpNext = Math.floor(p.xpNext * 1.4); recomputeStats(p); }
            }
          }
        }
        for (const b of world.bots) {
          if (b.team !== m.team) {
            const dd = Math.hypot(b.x - m.x, b.y - m.y);
            if (dd < 200) {
              b.gold += goldReward;
              b.xp  += xpReward;
              if (b.xp >= b.xpNext) { b.xp -= b.xpNext; b.level++; b.xpNext = Math.floor(b.xpNext * 1.4); recomputeStats(b); }
            }
          }
        }
        mobs.splice(i, 1);
      }
    }
  }

  // базы
  for (const b of world.bases) {
    if (b.hp <= 0) b.hp = 0;
  }

  // ---------- Боты: AI ----------
  for (const bot of world.bots) {
    if (bot.hp <= 0) continue;
    // тикаем кулдауны оружия
    for (const wKey of Object.keys(bot.weaponCooldowns)) {
      if (bot.weaponCooldowns[wKey] > 0) bot.weaponCooldowns[wKey]--;
    }
    if (bot.aiCooldown > 0) bot.aiCooldown--;

    // смотрим вокруг
    const hpPct = bot.hp / bot.maxHp;
    // ищем ближайшего врага (игрок + бот противника)
    let nearestEnemy = null, nearestDist = 250;
    for (const p of world.players.values()) {
      if (p.team === bot.team) continue;
      const d = Math.hypot(p.x - bot.x, p.y - bot.y);
      if (d < nearestDist) { nearestEnemy = p; nearestDist = d; }
    }
    for (const other of world.bots) {
      if (other === bot || other.team !== bot.team) continue;
      const d = Math.hypot(other.x - bot.x, other.y - bot.y);
      if (d < nearestDist) { nearestEnemy = other; nearestDist = d; }
    }
    // ищем ближайшего моба (своей команды — фарм; чужой — враг)
    let nearestAllyMob = null, nearestAllyMobDist = 999;
    let nearestEnemyMob = null, nearestEnemyMobDist = 999;
    for (const m of allMobs()) {
      const d = Math.hypot(m.x - bot.x, m.y - bot.y);
      if (m.team === bot.team && d < nearestAllyMobDist) { nearestAllyMob = m; nearestAllyMobDist = d; }
      if (m.team !== bot.team && d < nearestEnemyMobDist) { nearestEnemyMob = m; nearestEnemyMobDist = d; }
    }

    // ---- STATE TRANSITIONS ----
    // RETREAT: HP < 30% или плотный бой и HP < 50%
    if (hpPct < 0.3) bot.state = 'RETREAT';
    else if (bot.state === 'RETREAT' && hpPct > 0.6) bot.state = 'FARM';

    // FIGHT: враг в радиусе 200
    if (bot.state !== 'RETREAT' && nearestEnemy && nearestDist < 200) {
      bot.state = 'FIGHT';
    }

    // SHOP: мало HP + есть золото + рядом с магазином
    if ((hpPct < 0.5 && bot.gold >= 50) || (bot.inventory.length === 1 && bot.gold >= 80)) {
      const distShop = Math.hypot(bot.x - world.shop.x, bot.y - world.shop.y);
      if (distShop < 80) bot.state = 'SHOP';
    }

    // ---- ACTIONS ----
    if (bot.state === 'RETREAT') {
      // бежим к своей базе
      const myBase = world.bases.find(b => b.owner === bot.team);
      bot.targetX = myBase.x;
      bot.targetY = myBase.y;
      bot.targetAngle = Math.atan2(myBase.y - bot.y, myBase.x - bot.x);
    } else if (bot.state === 'FIGHT') {
      // целимся во врага
      bot.targetAngle = Math.atan2(nearestEnemy.y - bot.y, nearestEnemy.x - bot.x);
      // небольшой kite: держим дистанцию
      if (nearestDist < 80) {
        const ang = Math.atan2(bot.y - nearestEnemy.y, bot.x - nearestEnemy.x);
        bot.targetX = bot.x + Math.cos(ang) * 100;
        bot.targetY = bot.y + Math.sin(ang) * 100;
      } else {
        bot.targetX = bot.x;  // стоим
        bot.targetY = bot.y;
      }
    } else if (bot.state === 'SHOP') {
      // покупаем лучшее что можем
      if (bot.aiCooldown <= 0) {
        for (const [k, w] of Object.entries(WEAPONS)) {
          if (!bot.inventory.includes(k) && bot.gold >= w.price) {
            bot.gold -= w.price;
            bot.inventory.push(k);
            bot.weaponCooldowns[k] = 0;
            if (!bot.weaponMerge[k]) bot.weaponMerge[k] = 1;
            bot.aiCooldown = 30;
            break;
          }
        }
        // лечимся (телепорт на базу пока не реализован — просто +HP)
        bot.hp = Math.min(bot.maxHp, bot.hp + 30);
        bot.state = 'FARM';
      }
      bot.targetX = bot.x;
      bot.targetY = bot.y;
    } else {
      // FARM: идём к ближайшему чужому мобу / к вражеской стороне
      bot.state = 'FARM';
      if (nearestEnemyMob) {
        bot.targetX = nearestEnemyMob.x;
        bot.targetY = nearestEnemyMob.y;
        bot.targetAngle = Math.atan2(nearestEnemyMob.y - bot.y, nearestEnemyMob.x - bot.x);
      } else {
        // идём к центру/к вражеской стороне
        const enemyBase = world.bases.find(b => b.owner !== bot.team);
        bot.targetX = enemyBase.x + (Math.random()-0.5)*100;
        bot.targetY = enemyBase.y + 200;
        bot.targetAngle = Math.atan2(bot.targetY - bot.y, bot.targetX - bot.x);
      }
    }

    // ---- MOVEMENT (с учётом стены по центру) ----
    const dx = bot.targetX - bot.x;
    const dy = bot.targetY - bot.y;
    const dd = Math.hypot(dx, dy);
    if (dd > 4) {
      let nx = bot.x + (dx/dd) * bot.speed;
      let ny = bot.y + (dy/dd) * bot.speed;
      // отталкиваем от центральной стены
      [nx, ny] = blockCentralWall(nx, ny, 12);
      bot.x = Math.max(10, Math.min(MAP_W-10, nx));
      bot.y = Math.max(10, Math.min(MAP_H-10, ny));
    }

    // ---- SHOOTING (тот же pickTargets, что и у игрока) ----
    for (const wKey of bot.inventory) {
      const wpn = WEAPONS[wKey];
      if (!wpn) continue;
      if ((bot.weaponCooldowns[wKey] || 0) > 0) continue;
      const mergeCount = (bot.weaponMerge && bot.weaponMerge[wKey]) || 1;
      // прогрессивный множитель целей: 1к=1цель×1.0, 2к=2цели×0.75, 3к=3цели×0.75^2, ...
      const targets = mergeCount;
      const dmgMul = Math.pow(0.75, mergeCount - 1);
      bot.weaponCooldowns[wKey] = wpn.cooldown;
      const targetsList = pickTargets(bot, wpn.range, targets);
      if (targetsList.length === 0) continue;
      const pellets = wpn.pellets || 1;
      const pelletDmg = (wpn.dmg ?? (wpn.dmgPerPellet || 0)) + bot.dmgBonus;
      const baseDmg = pelletDmg * dmgMul;
      for (const tgt of targetsList) {
        for (let p2 = 0; p2 < pellets; p2++) {
          let ang;
          if (wpn.pellets) {
            const spread = (p2 - (wpn.pellets-1)/2) * 0.15;
            ang = bot.targetAngle + spread;
          } else {
            ang = Math.atan2(tgt.y - bot.y, tgt.x - bot.x);
          }
          world.projectiles.push({
            id: world.nextId++, ownerId: bot.id,
            x: bot.x, y: bot.y,
            vx: Math.cos(ang)*wpn.projSpeed, vy: Math.sin(ang)*wpn.projSpeed,
            dmg: baseDmg, range: wpn.range,
            traveled: 0, isCannon: wpn.isCannon || false,
          });
        }
      }
    }
  }

  // снаряды
  for (let i = world.projectiles.length - 1; i >= 0; i--) {
    const pr = world.projectiles[i];
    pr.x += pr.vx; pr.y += pr.vy;
    pr.traveled += Math.hypot(pr.vx, pr.vy);
    if (pr.traveled >= pr.range || pr.x < 0 || pr.x > MAP_W || pr.y < 0 || pr.y > MAP_H) {
      world.projectiles.splice(i, 1); continue;
    }
    // попадание
    let hit = null;
    for (const m of allMobs()) {
      if (Math.hypot(m.x - pr.x, m.y - pr.y) < 10) { hit = m; break; }
    }
    if (!hit) {
      for (const p of world.players.values()) {
        if (p.id !== pr.ownerId && Math.hypot(p.x - pr.x, p.y - pr.y) < 10) { hit = p; break; }
      }
    }
    // проверяем попадание в ботов своей команды (или любой команды)
    if (!hit) {
      for (const b of world.bots) {
        if (b.id !== pr.ownerId && b.hp > 0 && Math.hypot(b.x - pr.x, b.y - pr.y) < 10) { hit = b; break; }
      }
    }
    if (hit) {
      hit.hp -= Math.max(1, pr.dmg - (hit.armor || 0));
      // респаун бота у своей базы
      if (hit.isBot && hit.hp <= 0) {
        const myBase = world.bases.find(b => b.owner === hit.team);
        if (myBase) {
          hit.x = myBase.x + (Math.random()-0.5)*60;
          hit.y = hit.team === 'blue' ? MAP_H - 130 : 100;
          const def = HERO_DEFS[hit.hero];
          hit.hp = def.baseStats.hp;
          hit.maxHp = def.baseStats.hp;
        }
      }
      if (pr.isCannon) {
        // AoE по мобам вокруг
        for (const m of allMobs()) {
          if (Math.hypot(m.x - pr.x, m.y - pr.y) < 60) m.hp -= 8;
        }
      }
      world.projectiles.splice(i, 1);
    }
  }
}

// ---------- Выбор цели (75% крип / 25% герой) ----------
// Phoenix Fire-style: если рядом есть крип — бьём его, иначе героя.
// Но с шансом 25% — героя даже если есть крип (для разнообразия).
function pickTargets(player, range, count) {
  const mobsInRange = [];
  const heroesInRange = [];
  for (const m of allMobs()) {
    if (m.team === player.team) continue;
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (d <= range) mobsInRange.push(m);
  }
  for (const p of world.players.values()) {
    if (p.id === player.id || p.team === player.team) continue;
    const d = Math.hypot(p.x - player.x, p.y - player.y);
    if (d <= range) heroesInRange.push(p);
  }

  // если никого рядом — выходим
  if (mobsInRange.length === 0 && heroesInRange.length === 0) return [];

  // решаем, кого фокусим: 75% крип / 25% герой
  const focusMobs = heroesInRange.length === 0 || Math.random() < 0.75;
  const primary = focusMobs ? mobsInRange : heroesInRange;
  const secondary = focusMobs ? heroesInRange : mobsInRange;

  // выбираем count случайных целей из разных категорий (Phoenix Fire: случайный, не ближайший)
  const result = [];
  // перемешаем primary
  for (let i = primary.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [primary[i], primary[j]] = [primary[j], primary[i]];
  }
  for (const t of primary) {
    if (result.length >= count) break;
    result.push(t);
  }
  // если primary не хватило, добираем из secondary
  for (let i = secondary.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [secondary[i], secondary[j]] = [secondary[j], secondary[i]];
  }
  for (const t of secondary) {
    if (result.length >= count) break;
    result.push(t);
  }
  return result;
}

// ---------- Сетевой слой ----------
io.on('connection', (socket) => {
  let player = null;

  socket.on('join', ({ hero }) => {
    if (!HERO_DEFS[hero]) hero = 'agile';
    player = newPlayer(socket.id, hero);
    recomputeStats(player);
    world.players.set(socket.id, player);
    socket.emit('init', { id: player.id, weapons: WEAPONS, heroes: HERO_DEFS, mapW: MAP_W, mapH: MAP_H });
  });

  socket.on('input', (data) => {
    if (!player || player.hp <= 0) return;
    // движение: 8 направлений (если data.direction валидный) ИЛИ fallback на keys (4 направления)
    let dx = 0, dy = 0;
    if (Number.isInteger(data.direction) && data.direction >= 0 && data.direction < 8) {
      // 8 направлений: 0=N (север, -y), 1=NE, 2=E (+x), 3=SE, 4=S (+y), 5=SW, 6=W (-x), 7=NW
      // cos/sin: 0=вправо, увеличение по часовой стрелке (как atan2)
      const angles = [-Math.PI/2, -Math.PI/4, 0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, -3*Math.PI/4];
      const a = angles[data.direction];
      dx = Math.cos(a);
      dy = Math.sin(a);
    } else if (data.keys) {
      if (data.keys.up)    dy -= 1;
      if (data.keys.down)  dy += 1;
      if (data.keys.left)  dx -= 1;
      if (data.keys.right) dx += 1;
    }
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      let nx = player.x + (dx/len) * player.speed;
      let ny = player.y + (dy/len) * player.speed;
      [nx, ny] = blockCentralWall(nx, ny, 12);
      player.x = Math.max(10, Math.min(MAP_W-10, nx));
      player.y = Math.max(10, Math.min(MAP_H-10, ny));
    }
    if (data.aim) {
      player.targetAngle = Math.atan2(data.aim.y - player.y, data.aim.x - player.x);
    }
    // авто-атака: каждый ствол в инвентаре стреляет независимо по своей случайной цели в своём радиусе
    for (const wKey of player.inventory) {
      const wpn = WEAPONS[wKey];
      if (!wpn) continue;
      if ((player.weaponCooldowns[wKey] || 0) > 0) continue;

      // мерж: если 2+ одинаковых ствола — стреляем по 2 целям с 75% урона
      const mergeCount = (player.weaponMerge && player.weaponMerge[wKey]) || 1;
      // прогрессивный множитель целей: 1к=1цель×1.0, 2к=2цели×0.75, 3к=3цели×0.75^2, ...
      const targets = mergeCount;
      const dmgMul = Math.pow(0.75, mergeCount - 1);

      player.weaponCooldowns[wKey] = wpn.cooldown;

      // выбираем цели (75% крип / 25% герой, случайный)
      const targetsList = pickTargets(player, wpn.range, targets);
      if (targetsList.length === 0) continue;

      const pellets = wpn.pellets || 1;
      const pelletDmg = (wpn.dmg ?? (wpn.dmgPerPellet || 0)) + player.dmgBonus;
      const baseDmg = pelletDmg * dmgMul;

      const fireAt = (tgt) => {
        for (let p2 = 0; p2 < pellets; p2++) {
          // для дробовика — разлёт, для остальных — точно в цель
          let ang;
          if (wpn.pellets) {
            const spread = (p2 - (wpn.pellets-1)/2) * 0.15;
            ang = player.targetAngle + spread;
          } else {
            ang = Math.atan2(tgt.y - player.y, tgt.x - player.x);
          }
          world.projectiles.push({
            id: world.nextId++, ownerId: player.id,
            x: player.x, y: player.y,
            vx: Math.cos(ang)*wpn.projSpeed, vy: Math.sin(ang)*wpn.projSpeed,
            dmg: baseDmg, range: wpn.range,
            traveled: 0, isCannon: wpn.isCannon || false,
          });
        }
      };

      for (const tgt of targetsList) fireAt(tgt);
    }
  });

  socket.on('buyWeapon', ({ weapon }) => {
    if (!WEAPONS[weapon] || !player) return;
    // ЦЕНА: каждый следующий мерж того же ствола — +20% от базовой цены
    const basePrice = WEAPONS[weapon].price;
    const haveCount = player.inventory.includes(weapon)
      ? (player.weaponMerge && player.weaponMerge[weapon]) || 1
      : 0;
    // 1-й = базовая, 2-й = +20%, 3-й = +40%, и т.д. (скидка от количества сделанных мержей)
    const price = Math.round(basePrice * (1 + haveCount * 0.20));
    if (player.gold < price) return;
    if (player.inventory.length >= 6 && !player.inventory.includes(weapon)) return; // полон и нет такого
    player.gold -= price;

    // если уже есть — мержим (увеличиваем счетчик мержа, слот не занимаем!)
    if (player.inventory.includes(weapon)) {
      player.weaponMerge = player.weaponMerge || {};
      player.weaponMerge[weapon] = haveCount + 1;
    } else {
      player.inventory.push(weapon);
      player.weaponCooldowns[weapon] = 0;
    }
  });

  socket.on('mergeWeapon', ({ weapon }) => {
    // ручное слияние (если хотим) — но мы делаем авто при покупке
  });

  socket.on('levelSkill', ({ slot }) => {
    if (!player || slot < 0 || slot > 5) return;
    const cost = (player.skillLevels[slot] + 1) * 15;
    if (player.gold >= cost && player.skillLevels[slot] < 3) {
      player.gold -= cost;
      player.skillLevels[slot]++;
      recomputeStats(player);
    }
  });

  socket.on('disconnect', () => {
    world.players.delete(socket.id);
  });
});

// ---------- Рассылка состояния ----------
setInterval(() => {
  tick();
  const snapshot = {
    tick: world.tick,
    elapsedMs: Date.now() - world.matchStartTime,
    matchVersion: 'v0.5.0-mobs+merge+timer',
    bases: world.bases,
    shop: world.shop,
    players: [...world.players.values()].map(p => ({
      id: p.id, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp,
      hero: p.hero, name: p.name, color: p.color, shape: p.shape,
      gold: p.gold, inventory: p.inventory, level: p.level,
      skillLevels: p.skillLevels, targetAngle: p.targetAngle,
      weaponMerge: p.weaponMerge,
    })),
    mobs: [].concat(...Object.values(world.lanes).map(l => l.mobs)).map(m => ({
      id: m.id, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp,
      color: m.color, shape: m.shape, lane: m.lane, team: m.team,
      tier: m.tier, variant: m.variant, size: m.size, facing: m.facing, spawnNum: m.spawnNum,
    })),
    bots: world.bots.filter(b => b.hp > 0).map(b => ({
      id: b.id, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp,
      hero: b.hero, name: b.name, color: b.color, shape: b.shape,
      team: b.team, targetAngle: b.targetAngle, state: b.state,
    })),
    projectiles: world.projectiles.map(p => ({
      id: p.id, x: p.x, y: p.y, isCannon: p.isCannon,
    })),
  };
  io.emit('state', snapshot);
}, TICK_MS);

spawnInitialBots();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MOBA proto on http://0.0.0.0:${PORT}`);
  console.log(`Spawned ${world.bots.length} bots`);
});