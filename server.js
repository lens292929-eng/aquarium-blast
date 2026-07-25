const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve static assets (scripts.js, images, index.html)
app.use(express.static(__dirname));

// Fallback route to ensure index.html always loads
app.get('(.*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const players = {};

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 1. Join Game
  socket.on('joinGame', (data) => {
  const username = data.username || "Fish";
  const character = data.character || "Clownfish";
    players[socket.id] = {
      id: socket.id,
      x: Math.random() * (MAP_WIDTH - 200) + 100,
      y: Math.random() * (MAP_HEIGHT - 200) + 100,
      angle: 0,
      hp: 100,
      maxHp: 100,
      kills: 0,
      username: username,
      character: character,
      hasGun: true,
      isDashing: false,
      dashSpinAngle: 0,
      isDead: false
    };

    socket.emit('initMap', { width: MAP_WIDTH, height: MAP_HEIGHT });
    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);
    io.emit('leaderboardUpdate', getLeaderboard());
  });

  // 2. Chat System
  socket.on('chatMessage', (messageText) => {
    const player = players[socket.id];

    if (player && typeof messageText === 'string') {
      const cleanText = messageText.trim().substring(0, 80); // Cap message length at 80 characters

      if (cleanText.length > 0) {
        // Broadcast message to everyone with the player's actual username
        io.emit('newMessage', {
          username: player.username,
          text: cleanText
        });
      }
    }
  });

  // 3. Movement Sync
  socket.on('playerInput', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].angle = data.angle;
      players[socket.id].hasGun = data.hasGun;
      players[socket.id].isDashing = data.isDashing;
      players[socket.id].dashSpinAngle = data.dashSpinAngle;
      players[socket.id].isDead = data.isDead;

      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // 4. Damage & Kill Tracking
  socket.on('takeDamage', (data) => {
    const target = players[data.targetId];
    const attacker = players[socket.id];

    if (target && !target.isDead) {
      target.hp -= data.amount;
      
      if (target.hp <= 0) {
        target.hp = 0;
        target.isDead = true;

        if (attacker && attacker.id !== target.id) {
          attacker.kills = (attacker.kills || 0) + 1;
        }
      }

      io.emit('playerHealthUpdate', {
        id: data.targetId,
        hp: target.hp,
        isDead: target.isDead,
        attackerId: socket.id
      });

      io.emit('leaderboardUpdate', getLeaderboard());
    }
  });

  // 5. Respawn
  socket.on('respawnPlayer', () => {
    if (players[socket.id]) {
      players[socket.id].hp = 100;
      players[socket.id].isDead = false;
      players[socket.id].x = Math.random() * (MAP_WIDTH - 200) + 100;
      players[socket.id].y = Math.random() * (MAP_HEIGHT - 200) + 100;
      players[socket.id].hasGun = true;

      io.emit('playerRespawned', {
        id: socket.id,
        x: players[socket.id].x,
        y: players[socket.id].y,
        hp: 100
      });

      io.emit('leaderboardUpdate', getLeaderboard());
    }
  });

  // 6. Disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
    io.emit('leaderboardUpdate', getLeaderboard());
  });
});

function getLeaderboard() {
  return Object.values(players)
    .filter(p => p && p.username)
    .map(p => ({ username: p.username, kills: p.kills || 0 }))
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 5);
}

// Bind to 0.0.0.0 so Render can route traffic to it
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Aquarium Blast server running on port ${PORT}`);
});