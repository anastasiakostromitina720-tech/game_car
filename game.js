(function () {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const overlay = document.getElementById("overlay");
  const msg = document.getElementById("msg");
  const btnRestart = document.getElementById("btn-restart");

  const LANE_COUNT = 4;
  const ROAD_LEFT = 30;
  const LANE_W = (canvas.width - ROAD_LEFT * 2) / LANE_COUNT;
  const CAR_W = LANE_W * 0.55;
  const CAR_H = CAR_W * 1.35;
  const PLAYER_Y = canvas.height - CAR_H - 24;

  const colors = {
    player: "#3d8bfd",
    enemy: ["#e74c3c", "#9b59b6", "#f39c12", "#1abc9c", "#e67e22"],
  };

  let targetLane = 1;
  let playerX = laneCenterX(1) - CAR_W / 2;
  const laneSmooth = 0.18;

  let enemies = [];
  let spawnTimer = 0;
  let spawnInterval = 55;
  let speed = 4;
  let score = 0;
  let best = parseInt(localStorage.getItem("carDodgeBest") || "0", 10);
  bestEl.textContent = String(best);

  let running = true;
  let lastTs = 0;

  function laneCenterX(lane) {
    return ROAD_LEFT + (lane + 0.5) * LANE_W;
  }

  function spawnEnemy() {
    const lane = Math.floor(Math.random() * LANE_COUNT);
    const color = colors.enemy[Math.floor(Math.random() * colors.enemy.length)];
    enemies.push({
      lane,
      x: laneCenterX(lane) - CAR_W / 2,
      y: -CAR_H,
      w: CAR_W,
      h: CAR_H,
      color,
    });
  }

  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w - 2 &&
      a.x + a.w - 2 > b.x &&
      a.y < b.y + b.h - 2 &&
      a.y + a.h - 2 > b.y
    );
  }

  function drawRoad() {
    const x0 = ROAD_LEFT;
    const w = LANE_W * LANE_COUNT;
    ctx.fillStyle = "#1e1e28";
    ctx.fillRect(x0, 0, w, canvas.height);
    for (let i = 1; i < LANE_COUNT; i++) {
      const x = x0 + i * LANE_W;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.setLineDash([10, 14]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const grass = "rgba(40, 120, 60, 0.35)";
    ctx.fillStyle = grass;
    ctx.fillRect(0, 0, x0, canvas.height);
    ctx.fillRect(x0 + w, 0, canvas.width - x0 - w, canvas.height);
  }

  function drawCar(x, y, w, h, color, isPlayer) {
    const cy = y + h * 0.22;
    const bodyH = h * 0.78;
    ctx.fillStyle = color;
    ctx.fillRect(x + w * 0.08, cy, w * 0.84, bodyH);
    ctx.fillStyle = isPlayer ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)";
    ctx.fillRect(x + w * 0.18, y + h * 0.35, w * 0.64, h * 0.22);
    const wheelW = w * 0.14;
    const wheelH = h * 0.12;
    ctx.fillStyle = "#222";
    ctx.fillRect(x + w * 0.1, y + h * 0.1, wheelW, wheelH);
    ctx.fillRect(x + w * 0.76, y + h * 0.1, wheelW, wheelH);
    ctx.fillRect(x + w * 0.1, y + h * 0.78, wheelW, wheelH);
    ctx.fillRect(x + w * 0.76, y + h * 0.78, wheelW, wheelH);
  }

  function tryMovePlayer(dir) {
    if (!running) return;
    const n = targetLane + dir;
    if (n >= 0 && n < LANE_COUNT) targetLane = n;
  }

  document.addEventListener("keydown", (e) => {
    if (e.code === "ArrowLeft" || e.code === "KeyA") {
      e.preventDefault();
      tryMovePlayer(-1);
    } else if (e.code === "ArrowRight" || e.code === "KeyD") {
      e.preventDefault();
      tryMovePlayer(1);
    } else if (e.code === "Space" && !running) {
      e.preventDefault();
      restart();
    }
  });

  btnRestart.addEventListener("click", () => {
    restart();
  });

  function gameOver() {
    running = false;
    if (score > best) {
      best = score;
      localStorage.setItem("carDodgeBest", String(best));
      bestEl.textContent = String(best);
    }
    msg.textContent = "Врезались! Очки: " + Math.floor(score);
    overlay.classList.remove("hidden");
  }

  function restart() {
    running = true;
    targetLane = 1;
    playerX = laneCenterX(1) - CAR_W / 2;
    enemies = [];
    spawnTimer = 0;
    spawnInterval = 55;
    speed = 4;
    score = 0;
    lastTs = 0;
    overlay.classList.add("hidden");
  }

  function tick(ts) {
    if (lastTs === 0) lastTs = ts;
    const dt = Math.min(32, ts - lastTs) / 16.67;
    lastTs = ts;

    if (running) {
      const destX = laneCenterX(targetLane) - CAR_W / 2;
      playerX += (destX - playerX) * (1 - Math.pow(1 - laneSmooth, dt));

      spawnTimer += dt;
      if (spawnTimer >= spawnInterval) {
        spawnTimer = 0;
        spawnEnemy();
        spawnInterval = Math.max(24, spawnInterval * 0.99);
        speed = Math.min(11, speed + 0.02 * dt);
      }

      for (const e of enemies) {
        e.y += speed * dt;
      }
      enemies = enemies.filter((e) => e.y < canvas.height + 40);

      const player = {
        x: playerX,
        y: PLAYER_Y,
        w: CAR_W,
        h: CAR_H,
      };
      for (const e of enemies) {
        if (rectsOverlap(player, e)) {
          gameOver();
          break;
        }
      }

      score += 0.15 * dt;
    }

    scoreEl.textContent = String(Math.floor(score));

    drawRoad();
    for (const e of enemies) {
      drawCar(e.x, e.y, e.w, e.h, e.color, false);
    }
    drawCar(playerX, PLAYER_Y, CAR_W, CAR_H, colors.player, true);

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
