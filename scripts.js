const socket = io();

const myUsername = prompt("Enter your Fish Username:", "Clownfish") || "Clownfish";

socket.emit("joinGame", {
    username: myUsername,
    character: localStorage.getItem("character") || "Clownfish"
});

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
ctx.imageSmoothingEnabled = false; // keep pixel art crisp, no blur on scaled sprites

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  ctx.imageSmoothingEnabled = false; // resizing the canvas resets context state
});

// --- SPRITES ---
const fishImage = new Image(); fishImage.src = 'clownfish.png';
const crosshairImage = new Image(); crosshairImage.src = 'crosshair.png';
const dashImage = new Image(); dashImage.src = 'dash.png';
const gunImage = new Image(); gunImage.src = 'gun.png';
const bananaImage = new Image(); bananaImage.src = 'banana.png';
const bassFishImage = new Image();
bassFishImage.src = "bassfish.png";
const bassanaImage = new Image();
bassanaImage.src = "bassana.png";

// --- MAP & PLAYER OBJECTS ---
let MAP_WIDTH = 3000;
let MAP_HEIGHT = 3000;

const player = {
  x: MAP_WIDTH / 2,
  y: MAP_HEIGHT / 2,
  vx: 0,
  vy: 0,
  angle: 0,
  width: 60,
  height: 42,
  maxSpeed: 5,

  username: myUsername,
  character: localStorage.getItem("character") || "Clownfish",

  hp: 100,
  maxHp: 100,
  kills: 0,
  isDead: false,
  flopAngle: 0,

  isDashing: false,
  dashDuration: 0,
  dashSpinAngle: 0,
  lastDashTime: 0,
  dashCooldown: 10000,

  lastShootTime: 0,
  shootCooldown: 1000,

  hasGun: true,
  lastThrowTime: 0,
  throwCooldown: 20000,

  isBiting: false,
  biteTimer: 0,
  lastBiteTime: 0,
  biteCooldown: 250
};

const otherPlayers = {};
const bananas = [];
const thrownGuns = [];
const dashTrails = [];
let leaderboard = [];
let prevKillCounts = {}; // track kill deltas for kill-feed / banner

let screenShake = 0;
let deathOverlayAlpha = 0;
let mouse = { x: canvas.width / 2, y: canvas.height / 2 };
let elapsedFrames = 0;

// --- NEW: JUICE STATE ---
const particles = [];        // generic particle burst system (hits, deaths, dashes, bites)
const floatingTexts = [];    // floating damage numbers / banners
const ambientBubbles = [];   // background ambience
let hitFlashAlpha = 0;       // red pulse when local player takes damage
let lastLocalHp = player.hp;
let killBannerTimer = 0;
let killBannerText = '';

// seed ambient background bubbles once
for (let i = 0; i < 40; i++) {
  ambientBubbles.push({
    x: Math.random() * MAP_WIDTH,
    y: Math.random() * MAP_HEIGHT,
    r: 2 + Math.random() * 5,
    speed: 0.2 + Math.random() * 0.5,
    drift: (Math.random() - 0.5) * 0.3,
    alpha: 0.15 + Math.random() * 0.25
  });
}

function spawnParticles(x, y, count, color, opts = {}) {
  const speed = opts.speed || 3;
  const life = opts.life || 30;
  const size = opts.size || 4;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = Math.random() * speed;
    particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life,
      maxLife: life,
      color,
      size: size * (0.5 + Math.random() * 0.8)
    });
  }
}

function spawnFloatingText(x, y, text, color = '#ffffff', big = false) {
  floatingTexts.push({
    x, y, text, color,
    life: 45,
    maxLife: 45,
    size: big ? 26 : 15,
    vy: -1.1
  });
}

// --- MULTIPLAYER LISTENERS ---
socket.on('initMap', (data) => {
  MAP_WIDTH = data.width;
  MAP_HEIGHT = data.height;
});

socket.on('currentPlayers', (serverPlayers) => {
  Object.keys(serverPlayers).forEach((id) => {
    if (id !== socket.id) {
      otherPlayers[id] = serverPlayers[id];
    }
  });
});

socket.on('newPlayer', (p) => {
  otherPlayers[p.id] = p;
});

socket.on('playerMoved', (p) => {
  if (otherPlayers[p.id]) {
    otherPlayers[p.id].x = p.x;
    otherPlayers[p.id].y = p.y;
    otherPlayers[p.id].angle = p.angle;
    otherPlayers[p.id].hasGun = p.hasGun;
    otherPlayers[p.id].isDashing = p.isDashing;
    otherPlayers[p.id].dashSpinAngle = p.dashSpinAngle;
    otherPlayers[p.id].isDead = p.isDead;
  }
});

socket.on('playerHealthUpdate', (data) => {
  if (data.id === socket.id) {
    const dmg = lastLocalHp - data.hp;
    if (dmg > 0) {
      hitFlashAlpha = 0.55;
      screenShake = Math.max(screenShake, 10);
      spawnParticles(player.x, player.y, 10, '#ff4d4d', { speed: 4, life: 20, size: 3 });
      spawnFloatingText(player.x + (Math.random() - 0.5) * 20, player.y - 30, `-${dmg}`, '#ff5555');
    }
    lastLocalHp = data.hp;
    player.hp = data.hp;
    if (data.isDead && !player.isDead) {
      player.isDead = true;
      triggerDeath();
    }
  } else if (otherPlayers[data.id]) {
    const target = otherPlayers[data.id];
    const prevHp = target.hp;
    if (typeof prevHp === 'number' && data.hp < prevHp) {
      spawnParticles(target.x, target.y, 8, '#ff8080', { speed: 3, life: 18, size: 3 });
    }
    target.hp = data.hp;
    target.isDead = data.isDead;
    if (data.isDead) {
      spawnParticles(target.x, target.y, 26, '#ffffff', { speed: 5, life: 40, size: 4 });
    }
  }
});

socket.on('playerRespawned', (data) => {
  if (data.id === socket.id) {
    player.x = data.x;
    player.y = data.y;
    player.hp = 100;
    lastLocalHp = 100;
    player.isDead = false;
    player.vx = 0;
    player.vy = 0;
    deathOverlayAlpha = 0;
    spawnParticles(data.x, data.y, 22, '#66ffcc', { speed: 4, life: 30, size: 4 });
  } else if (otherPlayers[data.id]) {
    otherPlayers[data.id].x = data.x;
    otherPlayers[data.id].y = data.y;
    otherPlayers[data.id].hp = 100;
    otherPlayers[data.id].isDead = false;
  }
});

socket.on('leaderboardUpdate', (data) => {
  // detect a kill increase for the local player to trigger a banner
  const mine = data.find(e => e.username === player.username);
  if (mine) {
    const prev = prevKillCounts[player.username] ?? mine.kills;
    if (mine.kills > prev) {
      killBannerTimer = 90;
      killBannerText = 'ELIMINATION!';
    }
    prevKillCounts[player.username] = mine.kills;
  }
  leaderboard = data;
});

socket.on('playerDisconnected', (id) => {
  delete otherPlayers[id];
});

// --- DEATH SEQUENCE ---
function triggerDeath() {
  screenShake = 25;
  deathOverlayAlpha = 0.6;
  player.vx = (Math.random() - 0.5) * 16;
  player.vy = -12;
  spawnParticles(player.x, player.y, 35, '#ffffff', { speed: 6, life: 45, size: 5 });
  spawnParticles(player.x, player.y, 20, '#ff6666', { speed: 4, life: 35, size: 4 });

  setTimeout(() => {
    socket.emit('respawnPlayer');
  }, 2800);
}

// --- INPUT HANDLERS ---
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});

window.addEventListener('mousedown', (e) => {
  if (isChatting || player.isDead) return;
  if (e.button === 0) { // Left Click: Dash
    const currentTime = Date.now();
    if (currentTime - player.lastDashTime >= player.dashCooldown) {
      player.lastDashTime = currentTime;
      player.isDashing = true;
      player.dashDuration = 50;
      player.dashSpinAngle = 0;

      player.vx += Math.cos(player.angle) * 40;
      player.vy += Math.sin(player.angle) * 40;

      spawnParticles(player.x, player.y, 14, '#7fdfff', { speed: 5, life: 22, size: 4 });
    }
  }
  if (e.button === 1) performBite();
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!isChatting && !player.isDead) shootBananaPistol();
});

window.addEventListener('keydown', (e) => {
  if (isChatting || player.isDead) return;
  const key = e.key.toLowerCase();
  if (e.code === 'Space') shootBananaPistol();
  if (key === 'f') throwGun();
  if (key === 'e') performBite();
});

function performBite() {
  if (player.isDead) return;
  const currentTime = Date.now();
  if (currentTime - player.lastBiteTime >= player.biteCooldown) {
    player.lastBiteTime = currentTime;
    player.isBiting = true;
    player.biteTimer = 10;

    const biteX = player.x + Math.cos(player.angle) * 40;
    const biteY = player.y + Math.sin(player.angle) * 40;
    spawnParticles(biteX, biteY, 6, '#ffffff', { speed: 3, life: 12, size: 3 });

    Object.keys(otherPlayers).forEach((id) => {
      let p = otherPlayers[id];
      if (!p.isDead && Math.hypot(p.x - player.x, p.y - player.y) < 55) {
        socket.emit('takeDamage', { targetId: id, amount: 12 });
      }
    });
  }
}

function shootBananaPistol() {
  if (player.isDead) return;
  const currentTime = Date.now();
  if (currentTime - player.lastShootTime >= player.shootCooldown) {
    player.lastShootTime = currentTime;

    bananas.push({
      x: player.x + Math.cos(player.angle) * 35,
      y: player.y + Math.sin(player.angle) * 35,
      vx: Math.cos(player.angle) * 15,
      vy: Math.sin(player.angle) * 15,
      spin: 0.25,
      angle: player.angle,
      life: 60
    });

    spawnParticles(
      player.x + Math.cos(player.angle) * 35,
      player.y + Math.sin(player.angle) * 35,
      6, '#ffe066', { speed: 3, life: 12, size: 2.5 }
    );

    player.vx -= Math.cos(player.angle) * 3;
    player.vy -= Math.sin(player.angle) * 3;
  }
}

function throwGun() {
  if (player.isDead) return;
  const currentTime = Date.now();
  if (currentTime - player.lastThrowTime >= player.throwCooldown) {
    player.lastThrowTime = currentTime;

    thrownGuns.push({
      x: player.x + Math.cos(player.angle) * 25,
      y: player.y + Math.sin(player.angle) * 25,
      vx: Math.cos(player.angle) * 20,
      vy: Math.sin(player.angle) * 20,
      spinAngle: 0,
      life: 70
    });

    player.vx -= Math.cos(player.angle) * 5;
    player.vy -= Math.sin(player.angle) * 5;
  }
}

// --- GAME LOOP ---
function update() {
  elapsedFrames++;

  if (player.isDead) {
    player.vy += 0.45;
    player.x += player.vx;
    player.y += player.vy;
    player.flopAngle += 0.25;
  } else {
    // --------------------------------------------------
    // Twin-stick movement
    // --------------------------------------------------

    // Determine if we're on a touch device
const usingTouch =
    ('ontouchstart' in window) ||
    navigator.maxTouchPoints > 0;

let worldMouseX = mouse.x + (player.x - canvas.width / 2);
let worldMouseY = mouse.y + (player.y - canvas.height / 2);

let aimDX = worldMouseX - player.x;
let aimDY = worldMouseY - player.y;

if (Math.hypot(aimDX, aimDY) > 10) {
    player.angle = Math.atan2(aimDY, aimDX);
}

if (player.isBiting) {

    player.vx *= 0.5;
    player.vy *= 0.5;

    player.biteTimer--;

    if (player.biteTimer <= 0)
        player.isBiting = false;

}
else if (!player.isDashing) {

    if (usingTouch) {

        const deadZone = 0.15;

        if (
            Math.abs(moveInput.x) > deadZone ||
            Math.abs(moveInput.y) > deadZone
        ) {

            player.vx += moveInput.x * 0.35;
            player.vy += moveInput.y * 0.35;

        } else {

            player.vx *= 0.85;
            player.vy *= 0.85;

        }

    } else {

        // ORIGINAL PC MOVEMENT
        const fishRange = (player.width / 2) * 4;

        let dx = worldMouseX - player.x;
        let dy = worldMouseY - player.y;

        if (Math.hypot(dx, dy) > fishRange) {

            player.vx += Math.cos(player.angle) * 0.25;
            player.vy += Math.sin(player.angle) * 0.25;

        } else {

            player.vx *= 0.85;
            player.vy *= 0.85;

        }

    }

}

    // DASH LOGIC & TRAIL CREATION
    if (player.isDashing) {
      player.dashSpinAngle += (Math.PI * 2) / 15;
      player.dashDuration--;

      dashTrails.push({
        x: player.x,
        y: player.y,
        angle: player.angle,
        alpha: 0.6
      });

      if (player.dashDuration <= 0) {
        player.isDashing = false;
        player.dashSpinAngle = 0;
      }
    }

    player.vx *= 0.93;
    player.vy *= 0.93;
    player.x += player.vx;
    player.y += player.vy;

    // Boundaries
    player.x = Math.max(player.width / 2, Math.min(MAP_WIDTH - player.width / 2, player.x));
    player.y = Math.max(player.height / 2, Math.min(MAP_HEIGHT - player.height / 2, player.y));
  }

  // Fade out dash trails
  for (let i = dashTrails.length - 1; i >= 0; i--) {
    dashTrails[i].alpha -= 0.05;
    if (dashTrails[i].alpha <= 0) dashTrails.splice(i, 1);
  }

  // Network Sync
  socket.emit('playerInput', {
    x: player.x,
    y: player.y,
    angle: player.isDead ? player.flopAngle : player.angle,
    hasGun: player.hasGun,
    isDashing: player.isDashing,
    dashSpinAngle: player.dashSpinAngle,
    isDead: player.isDead
  });

  // Bananas
  for (let i = bananas.length - 1; i >= 0; i--) {
    let b = bananas[i];
    b.x += b.vx; b.y += b.vy; b.life--;

    Object.keys(otherPlayers).forEach((id) => {
      let p = otherPlayers[id];
      if (!p.isDead && Math.hypot(p.x - b.x, p.y - b.y) < 35) {
        socket.emit('takeDamage', { targetId: id, amount: 15 });
        bananas.splice(i, 1);
      }
    });

    if (b.life <= 0) bananas.splice(i, 1);
  }

  // Thrown Guns
  for (let i = thrownGuns.length - 1; i >= 0; i--) {
    let gun = thrownGuns[i];
    gun.x += gun.vx; gun.y += gun.vy; gun.spinAngle += 0.4; gun.life--;

    Object.keys(otherPlayers).forEach((id) => {
      let p = otherPlayers[id];
      if (!p.isDead && Math.hypot(p.x - gun.x, p.y - gun.y) < 45) {
        socket.emit('takeDamage', { targetId: id, amount: 80 });
        thrownGuns.splice(i, 1);
      }
    });

    if (gun.life <= 0) thrownGuns.splice(i, 1);
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.94;
    p.vy *= 0.94;
    p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }

  // Floating texts
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const t = floatingTexts[i];
    t.y += t.vy;
    t.life--;
    if (t.life <= 0) floatingTexts.splice(i, 1);
  }

  // Ambient bubbles drift upward and wrap around the map
  ambientBubbles.forEach(b => {
    b.y -= b.speed;
    b.x += b.drift;
    if (b.y < 0) b.y = MAP_HEIGHT;
    if (b.x < 0) b.x = MAP_WIDTH;
    if (b.x > MAP_WIDTH) b.x = 0;
  });

  if (screenShake > 0) screenShake *= 0.85;
  if (hitFlashAlpha > 0) hitFlashAlpha -= 0.03;
  if (killBannerTimer > 0) killBannerTimer--;

  draw();
  requestAnimationFrame(update);
}

// --- RENDER FUNCTION ---
function draw() {
  drawBackground();

  ctx.save();

  if (screenShake > 0.5) {
    ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
  }

  let camX = Math.round(player.x - canvas.width / 2);
  let camY = Math.round(player.y - canvas.height / 2);
  ctx.translate(-camX, -camY);

  // Ambient bubbles (world space, behind everything else)
  ambientBubbles.forEach(b => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(180, 235, 255, ${b.alpha})`;
    ctx.fill();
  });

  // 1. Map Borders (glowing)
  ctx.save();
  ctx.shadowColor = '#00aaff';
  ctx.shadowBlur = 20;
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 10;
  ctx.strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  ctx.restore();

  // 2. Dash Trails
  dashTrails.forEach(t => {
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle);
    ctx.globalAlpha = t.alpha;
    ctx.drawImage(dashImage, -player.width / 2 - 15, -player.height / 2, player.width + 30, player.height);
    ctx.restore();
  });

  // 3. Flying Bananas
  bananas.forEach(b => {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.drawImage(bananaImage, -20, -20, 40, 40);
    ctx.restore();
  });

  // 4. Thrown Guns
  thrownGuns.forEach(gun => {
    ctx.save();
    ctx.translate(gun.x, gun.y);
    ctx.rotate(gun.spinAngle);
    ctx.drawImage(gunImage, -20, -15, 40, 30);
    ctx.restore();
  });

  // 5. Particles (world space)
  particles.forEach(p => {
    const alpha = p.life / p.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // 6. Other Players
  Object.keys(otherPlayers).forEach((id) => {
    let p = otherPlayers[id];
    drawFish(p.x, p.y, p.angle + (p.dashSpinAngle || 0), p.username, p.hp, p.maxHp || 100, p.hasGun, p.isDead);
  });

  console.log("Character:", player.character);
  // 7. Local Player
  drawFish(
    player.x,
    player.y,
    player.angle,
    player.username,
    player.hp,
    player.maxHp,
    player.hasGun,
    player.isDead,
    player.character
);

  // 8. Floating damage numbers (world space, drawn above fish)
  floatingTexts.forEach(t => {
    const alpha = t.life / t.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = t.color;
    ctx.font = `900 ${t.size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeText(t.text, t.x, t.y);
    ctx.fillText(t.text, t.x, t.y);
  });
  ctx.globalAlpha = 1;

  ctx.restore();

  // --- UI ELEMENTS (screen space) ---
  if (!player.isDead) {
    ctx.drawImage(crosshairImage, mouse.x - 12, mouse.y - 12, 24, 24);
  }

  drawVignette();
  drawMinimap();
  drawLeaderboard();
  drawKillBanner();

  // Red hit flash
  if (hitFlashAlpha > 0) {
    ctx.fillStyle = `rgba(255, 0, 0, ${hitFlashAlpha * 0.35})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (player.isDead) {
    ctx.fillStyle = `rgba(120, 0, 0, ${deathOverlayAlpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 48px sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;
    ctx.fillText('YOU GOT ELIMINATED!', canvas.width / 2, canvas.height / 2 - 20);
    ctx.shadowBlur = 0;

    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = '#ffcccc';
    ctx.fillText('Respawning shortly...', canvas.width / 2, canvas.height / 2 + 30);
  }
}

function drawBackground() {
  // Deep ocean gradient that subtly shifts with time for a "caustic" feel
  const t = elapsedFrames * 0.002;
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, `hsl(200, 70%, ${14 + Math.sin(t) * 2}%)`);
  grad.addColorStop(1, `hsl(210, 80%, ${6 + Math.cos(t) * 1.5}%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawVignette() {
  const grad = ctx.createRadialGradient(
    canvas.width / 2, canvas.height / 2, canvas.height / 3,
    canvas.width / 2, canvas.height / 2, canvas.height * 0.75
  );
  const lowHp = player.hp / player.maxHp < 0.3;
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, lowHp ? 'rgba(120,0,0,0.45)' : 'rgba(0,10,25,0.45)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawKillBanner() {
  if (killBannerTimer <= 0) return;
  const alpha = Math.min(1, killBannerTimer / 20);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.font = '900 34px sans-serif';
  ctx.fillStyle = '#ffd23f';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 12;
  ctx.fillText(killBannerText, canvas.width / 2, 90);
  ctx.restore();
}

function drawFish(x, y, angle, username, hp, maxHp, hasGun, isDead, character) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));

  // --- 1. DRAW UI (HEALTH BAR & NAME) ABOVE FISH ---
  if (!isDead) {
    const barWidth = 60;
    const barHeight = 6;
    const barY = -40;
    const hpRatio = hp / maxHp;

    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    const nameWidth = ctx.measureText(username).width;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(-nameWidth / 2 - 6, barY - 16, nameWidth + 12, 14);

    ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
    ctx.fillRect(-barWidth / 2, barY, barWidth, barHeight);

    const currentHpWidth = Math.max(0, hpRatio * barWidth);

    ctx.fillStyle =
      hpRatio > 0.5 ? '#00ff66'
      : hpRatio > 0.25 ? '#ffcc00'
      : '#ff3333';

    ctx.fillRect(-barWidth / 2, barY, currentHpWidth, barHeight);

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(-barWidth / 2, barY, barWidth, barHeight);

    ctx.fillStyle = '#fff';
    ctx.fillText(username, 0, barY - 5);
  }

  // --- 2. DIRECTION & DEAD STATE ---
  const isFacingLeft = Math.cos(angle) < 0;

  if (isDead) {
    ctx.scale(1, -1);
    ctx.globalAlpha = 0.75;
  }

  // --- 3. PICK SPRITE ---
  let sprite = fishImage;

  if (character === "Bass Fish") {
    sprite = bassFishImage;
  }

  // --- 4. DRAW FISH ---
  ctx.save();

  if (isFacingLeft) {
    ctx.scale(-1, 1);
  }

  const fishWidth = 60;
  const fishHeight = 40;

  ctx.drawImage(
    sprite,
    -fishWidth / 2,
    -fishHeight / 2,
    fishWidth,
    fishHeight
  );

  ctx.restore();

  // --- 5. DRAW GUN ---
  if (hasGun && !isDead) {
    ctx.save();

    ctx.rotate(angle);

    if (isFacingLeft) {
      ctx.scale(1, -1);
    }

    if (character === "Bass Fish") {
      ctx.drawImage(bassanaImage, 10, -12, 40, 28);
    } else {
      ctx.drawImage(gunImage, 10, -12, 40, 28);
    }

    ctx.restore();
  }

  ctx.restore();
}

function drawMinimap() {
  const size = 150;
  const padding = 20;
  const x = canvas.width - size - padding;
  const y = canvas.height - size - padding;

  ctx.fillStyle = 'rgba(0, 20, 40, 0.75)';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = '#00aaff';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);

  ctx.fillStyle = '#7fdfff';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('MAP', x + 6, y + 12);

  Object.keys(otherPlayers).forEach((id) => {
    let p = otherPlayers[id];
    if (!p.isDead) {
      let miniX = x + (p.x / MAP_WIDTH) * size;
      let miniY = y + (p.y / MAP_HEIGHT) * size;
      ctx.fillStyle = '#ff3366';
      ctx.beginPath();
      ctx.arc(miniX, miniY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  if (!player.isDead) {
    let miniX = x + (player.x / MAP_WIDTH) * size;
    let miniY = y + (player.y / MAP_HEIGHT) * size;
    ctx.save();
    ctx.translate(miniX, miniY);
    ctx.rotate(player.angle);
    ctx.fillStyle = '#00ff66';
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, 4);
    ctx.lineTo(-4, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawLeaderboard() {
  const width = 190;
  const x = canvas.width - width - 20;
  const y = 20;
  const rowHeight = 22;

  ctx.fillStyle = 'rgba(0, 20, 40, 0.75)';
  ctx.fillRect(x, y, width, 30 + leaderboard.length * rowHeight);
  ctx.strokeStyle = '#00aaff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, width, 30 + leaderboard.length * rowHeight);

  ctx.fillStyle = '#00aaff';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('LEADERBOARD', x + 12, y + 20);

  const medalColors = ['#ffd23f', '#c9d3dc', '#cd7f32'];

  leaderboard.forEach((entry, i) => {
    const rowY = y + 42 + i * rowHeight;
    const isMe = entry.username === player.username;

    if (isMe) {
      ctx.fillStyle = 'rgba(0, 170, 255, 0.18)';
      ctx.fillRect(x + 2, rowY - 15, width - 4, rowHeight);
    }

    ctx.fillStyle = i < 3 ? medalColors[i] : '#ffffff';
    ctx.font = i < 3 ? 'bold 12px sans-serif' : '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}. ${entry.username}`, x + 12, rowY);
    ctx.textAlign = 'right';
    ctx.fillText(`${entry.kills} K`, x + width - 12, rowY);
    ctx.textAlign = 'left';
  });
}

// ==========================================
// CHAT & CONTROLS INTEGRATION
// ==========================================

const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');

let isChatting = false;

// Handle toggling chat with 'Enter' key
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (document.activeElement === chatInput) {
      // Send message
      const text = chatInput.value.trim();
      if (text.length > 0) {
        socket.emit('chatMessage', text);
      }
      chatInput.value = '';
      chatInput.blur();
      isChatting = false;
    } else {
      // Focus chat box
      chatInput.focus();
      isChatting = true;
    }
  }
});


// 1. Send chat message when pressing Enter
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const message = chatInput.value.trim();
      if (message !== '') {
        socket.emit('chatMessage', message);
        chatInput.value = ''; // Clear input field
      }
    }
  });
}

// 2. Receive chat message from server and display it
socket.on('newMessage', (data) => {
  if (!chatMessages) return;

  const msgElement = document.createElement('div');
  msgElement.className = 'chat-msg';
  
  // Use textContent for safety to prevent HTML injection
  const usernameSpan = document.createElement('span');
  usernameSpan.className = 'username';
  usernameSpan.textContent = `${data.username}: `;

  const textNode = document.createTextNode(data.text);

  msgElement.appendChild(usernameSpan);
  msgElement.appendChild(textNode);
  
  chatMessages.appendChild(msgElement);
  
  // Auto-scroll to latest message
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ======================================================
// MOBILE TWIN-STICK CONTROLS
// Replace the old joystick section with this.
// ======================================================

let moveInput = {
    x: 0,
    y: 0
};

window.addEventListener("DOMContentLoaded", () => {

    const moveBase = document.getElementById("move-base");
    const moveStick = document.getElementById("move-stick");

    const aimBase = document.getElementById("aim-base");
    const aimStick = document.getElementById("aim-stick");

    const btnShoot = document.getElementById("btn-shoot");
    const btnDash = document.getElementById("btn-dash");
    const btnBite = document.getElementById("btn-bite");
    const btnThrow = document.getElementById("btn-throw");

    const STICK_RADIUS = 45;
    const AIM_DISTANCE = 180;

    let moveTouch = null;
    let aimTouch = null;

    function clamp(dx, dy) {
        const d = Math.hypot(dx, dy);

        if (d <= STICK_RADIUS) {
            return {
                x: dx,
                y: dy,
                strength: d / STICK_RADIUS
            };
        }

        return {
            x: dx / d * STICK_RADIUS,
            y: dy / d * STICK_RADIUS,
            strength: 1
        };
    }

    function handleMoveJoystick(touch) {

        const rect = moveBase.getBoundingClientRect();

        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        let dx = touch.clientX - cx;
        let dy = touch.clientY - cy;

        const result = clamp(dx, dy);

        moveStick.style.transform =
            `translate(${result.x}px, ${result.y}px)`;

        moveInput.x = result.x / STICK_RADIUS;
        moveInput.y = result.y / STICK_RADIUS;
    }

    function handleAimJoystick(touch) {

        const rect = aimBase.getBoundingClientRect();

        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        let dx = touch.clientX - cx;
        let dy = touch.clientY - cy;

        const result = clamp(dx, dy);

        aimStick.style.transform =
            `translate(${result.x}px, ${result.y}px)`;

        const angle = Math.atan2(result.y, result.x);

        player.angle = angle;

        mouse.x =
            canvas.width / 2 +
            Math.cos(angle) * AIM_DISTANCE * result.strength;

        mouse.y =
            canvas.height / 2 +
            Math.sin(angle) * AIM_DISTANCE * result.strength;
    }

    function startTouch(e) {

        for (const touch of e.changedTouches) {

            if (
                moveBase.contains(touch.target) &&
                moveTouch === null
            ) {

                moveTouch = touch.identifier;
                handleMoveJoystick(touch);

            } else if (
                aimBase.contains(touch.target) &&
                aimTouch === null
            ) {

                aimTouch = touch.identifier;
                handleAimJoystick(touch);
            }
        }

        e.preventDefault();
    }

    function moveTouchHandler(e) {

        for (const touch of e.changedTouches) {

            if (touch.identifier === moveTouch)
                handleMoveJoystick(touch);

            if (touch.identifier === aimTouch)
                handleAimJoystick(touch);
        }

        e.preventDefault();
    }

    function endTouch(e) {

        for (const touch of e.changedTouches) {

            if (touch.identifier === moveTouch) {

                moveTouch = null;

                moveInput.x = 0;
                moveInput.y = 0;

                moveStick.style.transform =
                    "translate(0px,0px)";
            }

            if (touch.identifier === aimTouch) {

                aimTouch = null;

                aimStick.style.transform =
                    "translate(0px,0px)";

                mouse.x = canvas.width / 2;
                mouse.y = canvas.height / 2;
            }
        }
    }

    moveBase.addEventListener("touchstart", startTouch, {
        passive:false
    });

    aimBase.addEventListener("touchstart", startTouch, {
        passive:false
    });

    window.addEventListener("touchmove", moveTouchHandler,{
        passive:false
    });

    window.addEventListener("touchend", endTouch);

    window.addEventListener("touchcancel", endTouch);

    function bind(button, action){

        if(!button) return;

        button.addEventListener("touchstart",(e)=>{

            e.preventDefault();

            action();

        },{passive:false});
    }

    bind(btnShoot,()=>{

        shootBananaPistol();

    });

    bind(btnBite,()=>{

        performBite();

    });

    bind(btnThrow,()=>{

        throwGun();

    });

    bind(btnDash,()=>{

        const currentTime = Date.now();

        if(currentTime-player.lastDashTime>=player.dashCooldown){

            player.lastDashTime=currentTime;

            player.isDashing=true;
            player.dashDuration=50;
            player.dashSpinAngle=0;

            player.vx+=Math.cos(player.angle)*40;
            player.vy+=Math.sin(player.angle)*40;

            spawnParticles(
                player.x,
                player.y,
                14,
                "#7fdfff",
                {
                    speed:5,
                    life:22,
                    size:4
                }
            );
        }

    });

});

const characters = [

{
    name: "Clownfish",
    sprite: "clownfish.png",
    weapon: "🍌 Banana Gun",
    desc: "A balanced fish that starts with the Banana Gun."
},

{
    name: "Bass Fish",
    sprite: "bassfish.png",
    weapon: "🎸 Bassana",
    desc: "Drops the bass... literally."
}

];

let selectedCharacter = 0;

function updateCharacter(){

    const c = characters[selectedCharacter];

    document.getElementById("character-preview").src = c.sprite;
    document.getElementById("character-name").textContent = c.name;
    document.getElementById("character-weapon").textContent = c.weapon;
    document.getElementById("character-desc").textContent = c.desc;

}

document.getElementById("next-btn").onclick = ()=>{

    selectedCharacter++;

    if(selectedCharacter>=characters.length)
        selectedCharacter=0;

    updateCharacter();

};

document.getElementById("prev-btn").onclick = ()=>{

    selectedCharacter--;

    if(selectedCharacter<0)
        selectedCharacter=characters.length-1;

    updateCharacter();

};

document.getElementById("play-btn").onclick = ()=>{

    localStorage.setItem(
        "character",
        characters[selectedCharacter].name
    );

    document.getElementById("character-select").style.display="none";

};

updateCharacter();

update();