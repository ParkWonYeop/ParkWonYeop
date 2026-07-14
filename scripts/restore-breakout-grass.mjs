import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DURATION_MS = 150_000;
const DRAIN_START_MS = 100_000;
const LOOP_RETURN_START_MS = 145_000;
const RESPAWN_MIN_MS = 30_000;
const RESPAWN_TARGET_MAX_MS = 38_500;
const RESPAWN_HARD_MAX_MS = 40_000;
const RESPAWN_ESCAPE_MS = 39_000;
const RESPAWN_ESCAPE_RETRY_MS = 250;
const MIN_RESPAWN_VISIBLE_MS = 250;
const TRAP_WINDOW_MS = 2_000;
const MIN_TRAP_MOTION_SPAN = 40;
const FPS = 30;
const BALL_SPEED = 235;
const IDLE_BALL_SPEED = BALL_SPEED * 0.65;
const PADDLE_SPEED = 900;
const PADDLE_GRID_GAP = 20;
const PADDLE_BOTTOM_MARGIN = 8;
const ACCENT = '#B6F13A';
const HIDDEN_FILL = 'transparent';

const palettes = {
  light: {
    none: '#EBEDF0',
    colors: new Map([
      ['#ebedf0', '#EBEDF0'],
      ['#9be9a8', '#D9F99D'],
      ['#40c463', '#BEF264'],
      ['#30a14e', '#84CC16'],
      ['#216e39', '#3F6212']
    ])
  },
  dark: {
    none: '#161B22',
    colors: new Map([
      ['#161b22', '#161B22'],
      ['#0e4429', '#365314'],
      ['#006d32', '#4D7C0F'],
      ['#26a641', '#84CC16'],
      ['#39d353', '#BEF264']
    ])
  }
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const formatNumber = (value, precision = 4) =>
  value.toFixed(precision).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

const formatTime = (timeMs) => {
  if (timeMs <= 0) return '0';
  if (timeMs >= DURATION_MS) return '1';
  return formatNumber(timeMs / DURATION_MS, 6);
};

const getAttribute = (tag, name) => {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match?.[1];
};

const replaceAttribute = (tag, name, value) =>
  tag.replace(new RegExp(`${name}="[^"]*"`), `${name}="${value}"`);

const circleIntersectsCell = (ball, cell, radius) => {
  const nearestX = clamp(ball.x, cell.x, cell.x + cell.width);
  const nearestY = clamp(ball.y, cell.y, cell.y + cell.height);
  const dx = ball.x - nearestX;
  const dy = ball.y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
};

const respawnDelay = (cell) => {
  const seed = (
    Math.imul(cell.column + 1, 73_856_093) ^
    Math.imul(cell.row + 1, 19_349_663) ^
    Math.imul(cell.hitCount + 1, 83_492_791)
  ) >>> 0;
  return RESPAWN_MIN_MS + (seed % (RESPAWN_TARGET_MAX_MS - RESPAWN_MIN_MS + 1));
};

const parseSvg = (source, palette) => {
  const svgTag = source.match(/<svg[^>]*>/)?.[0];
  const ballTag = source.match(/<circle id="ball"[^>]*>/)?.[0];
  const paddleTag = source.match(/<rect id="paddle"[^>]*>/)?.[0];
  if (!svgTag || !ballTag || !paddleTag) {
    throw new Error('Missing SVG, ball, or paddle geometry');
  }

  const width = Number(getAttribute(svgTag, 'width'));
  const height = Number(getAttribute(svgTag, 'height'));
  const ballRadius = Number(getAttribute(ballTag, 'r'));
  const sourcePaddleY = Number(getAttribute(paddleTag, 'y'));
  const paddleWidth = Number(getAttribute(paddleTag, 'width'));
  const paddleHeight = Number(getAttribute(paddleTag, 'height'));

  const cells = [];
  const cellPattern = /<rect id="c-(\d+)-(\d+)"([^>]*)>([\s\S]*?)<\/rect>/g;
  for (const match of source.matchAll(cellPattern)) {
    const openingTag = `<rect id="c-${match[1]}-${match[2]}"${match[3]}>`;
    const fillAnimation = match[4].match(/<animate\s+attributeName="fill"[\s\S]*?\/>/)?.[0];
    const firstAnimatedColor = fillAnimation ? getAttribute(fillAnimation, 'values')?.split(';')[0] : undefined;
    const sourceColor = firstAnimatedColor ?? getAttribute(openingTag, 'fill');
    if (!sourceColor) throw new Error(`Missing initial color for c-${match[1]}-${match[2]}`);

    const initialColor = palette.colors.get(sourceColor.toLowerCase()) ?? sourceColor;
    cells.push({
      id: `c-${match[1]}-${match[2]}`,
      column: Number(match[1]),
      row: Number(match[2]),
      x: Number(getAttribute(openingTag, 'x')),
      y: Number(getAttribute(openingTag, 'y')),
      width: Number(getAttribute(openingTag, 'width')),
      height: Number(getAttribute(openingTag, 'height')),
      initialColor,
      active: initialColor.toLowerCase() !== palette.none.toLowerCase(),
      breakable: initialColor.toLowerCase() !== palette.none.toLowerCase(),
      events: [],
      hitCount: 0,
      lastHitAt: null,
      lastRespawnAt: null,
      respawnEligibleAt: null,
      lastEscapeSteerAt: null
    });
  }

  if (cells.length !== 371) {
    throw new Error(`Expected 371 contribution cells, found ${cells.length}`);
  }

  const gridBottom = Math.max(...cells.map((cell) => cell.y + cell.height));
  const maximumPaddleY = height - paddleHeight - PADDLE_BOTTOM_MARGIN;
  const paddleY = Math.min(Math.max(sourcePaddleY, gridBottom + PADDLE_GRID_GAP), maximumPaddleY);
  if (paddleY - gridBottom < PADDLE_GRID_GAP) {
    throw new Error('Not enough SVG height to separate the paddle from the contribution grid');
  }

  return { width, height, ballRadius, paddleY, paddleWidth, paddleHeight, cells };
};

const simulate = (geometry) => {
  const { width, height, ballRadius, paddleY, paddleWidth, paddleHeight, cells } = geometry;
  const breakableCells = cells.filter((cell) => cell.breakable);
  if (breakableCells.length === 0) throw new Error('No active contribution cells found');

  const gridTop = Math.min(...cells.map((cell) => cell.y));
  const gridBottom = Math.max(...cells.map((cell) => cell.y + cell.height));
  const idleY = paddleY - ballRadius;
  if (idleY - ballRadius <= gridBottom) {
    throw new Error('Not enough clearance for the seamless return lane');
  }
  const ball = {
    x: width / 2,
    y: idleY,
    vx: 0,
    vy: -BALL_SPEED
  };
  let paddleX = clamp(ball.x - paddleWidth / 2, 0, width - paddleWidth);
  let targetCursor = 0;
  let totalHits = 0;
  let respawnedHits = 0;
  let respawnEscapeSteers = 0;
  let boundaryRecoveries = 0;
  let drainStarted = false;
  let idleMode = false;
  let idleEnteredAt = null;
  const respawnDurations = [];
  const respawnVisibleDurations = [];

  const chooseTarget = () => {
    const activeCells = breakableCells.filter((cell) => cell.active);
    if (activeCells.length === 0) return null;

    const respawned = activeCells
      .filter((cell) => cell.lastRespawnAt !== null)
      .sort((a, b) => b.lastRespawnAt - a.lastRespawnAt || Math.abs(a.x - ball.x) - Math.abs(b.x - ball.x));
    if (respawned.length > 0) return respawned[0];

    const unhit = activeCells
      .filter((cell) => cell.hitCount === 0)
      .sort((a, b) => Math.abs(a.x - ball.x) - Math.abs(b.x - ball.x) || a.row - b.row);
    if (unhit.length > 0) return unhit[targetCursor++ % unhit.length];

    const target = activeCells[targetCursor++ % activeCells.length];
    return target;
  };

  const aimBallUpward = () => {
    const target = chooseTarget();
    if (!target) {
      ball.vx = BALL_SPEED * 0.35;
      ball.vy = -Math.sqrt(BALL_SPEED ** 2 - ball.vx ** 2);
      return;
    }

    const targetX = target.x + target.width / 2;
    const targetY = target.y + target.height / 2;
    const verticalDistance = Math.max(ball.y - targetY, 20);
    const angle = clamp(Math.atan2(targetX - ball.x, verticalDistance), -Math.PI / 3, Math.PI / 3);
    ball.vx = BALL_SPEED * Math.sin(angle);
    ball.vy = -BALL_SPEED * Math.cos(angle);
  };

  const resolveCellCollision = (cell, previousX, previousY) => {
    const left = cell.x;
    const right = cell.x + cell.width;
    const top = cell.y;
    const bottom = cell.y + cell.height;

    if (previousY + ballRadius <= top) {
      ball.y = top - ballRadius;
      ball.vy = -Math.abs(ball.vy);
      return;
    }
    if (previousY - ballRadius >= bottom) {
      ball.y = bottom + ballRadius;
      ball.vy = Math.abs(ball.vy);
      return;
    }
    if (previousX + ballRadius <= left) {
      ball.x = left - ballRadius;
      ball.vx = -Math.abs(ball.vx);
      return;
    }
    if (previousX - ballRadius >= right) {
      ball.x = right + ballRadius;
      ball.vx = Math.abs(ball.vx);
      return;
    }

    const nearestX = clamp(ball.x, left, right);
    const nearestY = clamp(ball.y, top, bottom);
    let normalX = ball.x - nearestX;
    let normalY = ball.y - nearestY;
    let distance = Math.hypot(normalX, normalY);

    if (distance === 0) {
      const edges = [
        { distance: Math.abs(ball.x - left), nx: -1, ny: 0, x: left - ballRadius, y: ball.y },
        { distance: Math.abs(right - ball.x), nx: 1, ny: 0, x: right + ballRadius, y: ball.y },
        { distance: Math.abs(ball.y - top), nx: 0, ny: -1, x: ball.x, y: top - ballRadius },
        { distance: Math.abs(bottom - ball.y), nx: 0, ny: 1, x: ball.x, y: bottom + ballRadius }
      ].sort((a, b) => a.distance - b.distance);
      const edge = edges[0];
      normalX = edge.nx;
      normalY = edge.ny;
      ball.x = edge.x;
      ball.y = edge.y;
    } else {
      normalX /= distance;
      normalY /= distance;
      const penetration = ballRadius - distance;
      ball.x += normalX * penetration;
      ball.y += normalY * penetration;
    }

    const approachSpeed = ball.vx * normalX + ball.vy * normalY;
    if (approachSpeed < 0) {
      ball.vx -= 2 * approachSpeed * normalX;
      ball.vy -= 2 * approachSpeed * normalY;
    }
  };

  const steerBallAwayFromCell = (cell) => {
    const centerX = cell.x + cell.width / 2;
    const centerY = cell.y + cell.height / 2;
    let dx = ball.x - centerX;
    let dy = ball.y - centerY;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.001) {
      dx = 0;
      dy = 1;
    } else {
      dx /= distance;
      dy /= distance;
    }
    ball.vx = dx * BALL_SPEED;
    ball.vy = dy * BALL_SPEED;
  };

  const processRespawns = (timeMs, ballOutsidePlayfield = false) => {
    const clearanceRadius = ballRadius + BALL_SPEED * (MIN_RESPAWN_VISIBLE_MS / 1000);
    let escapeSteeredThisStep = false;
    for (const cell of breakableCells) {
      if (cell.active || cell.respawnEligibleAt === null || timeMs < cell.respawnEligibleAt) continue;
      if (ballOutsidePlayfield || !circleIntersectsCell(ball, cell, clearanceRadius)) {
        cell.active = true;
        cell.lastRespawnAt = timeMs;
        cell.respawnEligibleAt = null;
        cell.events.push({ timeMs, active: true });
        respawnDurations.push(timeMs - cell.lastHitAt);
        continue;
      }

      const escapeAt = cell.lastHitAt + RESPAWN_ESCAPE_MS;
      const maySteerAgain =
        cell.lastEscapeSteerAt === null || timeMs - cell.lastEscapeSteerAt >= RESPAWN_ESCAPE_RETRY_MS;
      if (timeMs >= escapeAt && maySteerAgain && !escapeSteeredThisStep) {
        steerBallAwayFromCell(cell);
        cell.lastEscapeSteerAt = timeMs;
        respawnEscapeSteers += 1;
        escapeSteeredThisStep = true;
      }
    }
  };

  const ballFrames = [{ x: ball.x, y: ball.y }];
  const paddleFrames = [{ x: paddleX }];
  aimBallUpward();

  const totalFrames = Math.round((DURATION_MS / 1000) * FPS);
  const frameSeconds = 1 / FPS;

  for (let frame = 1; frame <= totalFrames; frame += 1) {
    const frameTimeMs = frame * frameSeconds * 1000;
    const paddleStep = PADDLE_SPEED * frameSeconds;

    if (!drainStarted && frameTimeMs >= DRAIN_START_MS) {
      drainStarted = true;
    }

    if (idleMode) {
      processRespawns(frameTimeMs, true);

      if (frameTimeMs >= LOOP_RETURN_START_MS) {
        const returnStep = IDLE_BALL_SPEED * frameSeconds;
        const returnDistance = width / 2 - ball.x;
        ball.x += clamp(returnDistance, -returnStep, returnStep);
        ball.vx = Math.abs(returnDistance) <= returnStep ? 0 : Math.sign(returnDistance) * IDLE_BALL_SPEED;
      } else {
        ball.x += ball.vx * frameSeconds;
        if (ball.x - ballRadius <= 0) {
          ball.x = ballRadius;
          ball.vx = Math.abs(ball.vx);
        } else if (ball.x + ballRadius >= width) {
          ball.x = width - ballRadius;
          ball.vx = -Math.abs(ball.vx);
        }
      }
      ball.y = idleY;

      const paddleTarget = clamp(ball.x - paddleWidth / 2, 0, width - paddleWidth);
      paddleX += clamp(paddleTarget - paddleX, -paddleStep, paddleStep);
      ballFrames.push({ x: ball.x, y: ball.y });
      paddleFrames.push({ x: paddleX });
      continue;
    }

    if (drainStarted) {
      ball.vx = clamp(ball.vx, -BALL_SPEED * 0.35, BALL_SPEED * 0.35);
      ball.vy = Math.sqrt(BALL_SPEED ** 2 - ball.vx ** 2);
    }

    const paddleTarget = clamp(ball.x - paddleWidth / 2, 0, width - paddleWidth);
    paddleX += clamp(paddleTarget - paddleX, -paddleStep, paddleStep);

    const travelDistance = Math.hypot(ball.vx, ball.vy) * frameSeconds;
    const subSteps = Math.max(1, Math.ceil(travelDistance / Math.max(ballRadius * 0.45, 1)));
    const subSeconds = frameSeconds / subSteps;

    for (let subStep = 0; subStep < subSteps; subStep += 1) {
      const subStepStartMs = ((frame - 1) + subStep / subSteps) * frameSeconds * 1000;
      const timeMs = ((frame - 1) + (subStep + 1) / subSteps) * frameSeconds * 1000;

      processRespawns(subStepStartMs);

      const previousX = ball.x;
      const previousY = ball.y;
      ball.x += ball.vx * subSeconds;
      ball.y += ball.vy * subSeconds;

      if (ball.x - ballRadius <= 0) {
        ball.x = ballRadius;
        ball.vx = Math.abs(ball.vx);
      } else if (ball.x + ballRadius >= width) {
        ball.x = width - ballRadius;
        ball.vx = -Math.abs(ball.vx);
      }

      if (ball.y - ballRadius <= gridTop) {
        ball.y = gridTop + ballRadius;
        ball.vy = Math.abs(ball.vy);
      }

      if (drainStarted && ball.y >= idleY) {
        ball.y = idleY;
        const fallbackDirection = ball.x < width / 2 ? 1 : -1;
        const idleDirection = Math.abs(ball.vx) >= 1 ? Math.sign(ball.vx) : fallbackDirection;
        ball.vx = idleDirection * IDLE_BALL_SPEED;
        ball.vy = 0;
        idleMode = true;
        idleEnteredAt = timeMs;
        break;
      }

      if (
        !drainStarted &&
        ball.vy > 0 &&
        previousY + ballRadius <= paddleY &&
        ball.y + ballRadius >= paddleY &&
        ball.x >= paddleX - ballRadius &&
        ball.x <= paddleX + paddleWidth + ballRadius
      ) {
        ball.y = paddleY - ballRadius;
        aimBallUpward();
      }

      for (const cell of breakableCells) {
        if (!cell.active || !circleIntersectsCell(ball, cell, ballRadius)) continue;

        resolveCellCollision(cell, previousX, previousY);
        if (drainStarted) ball.vy = Math.abs(ball.vy);
        const hitAfterRespawn = cell.lastRespawnAt !== null;
        if (hitAfterRespawn) {
          const visibleDuration = timeMs - cell.lastRespawnAt;
          if (visibleDuration < MIN_RESPAWN_VISIBLE_MS) {
            throw new Error(
              `${cell.id} was hit only ${formatNumber(visibleDuration, 1)}ms after respawning`
            );
          }
          respawnVisibleDurations.push(visibleDuration);
        }
        cell.active = false;
        cell.events.push({ timeMs, active: false });
        cell.hitCount += 1;
        cell.lastHitAt = timeMs;
        cell.respawnEligibleAt = timeMs + respawnDelay(cell);
        totalHits += 1;
        if (hitAfterRespawn) respawnedHits += 1;
        break;
      }

      if (ball.y + ballRadius >= height) {
        ball.y = height - ballRadius;
        ball.vy = -Math.abs(ball.vy);
        boundaryRecoveries += 1;
      }
    }

    ballFrames.push({ x: ball.x, y: ball.y });
    paddleFrames.push({ x: paddleX });
  }

  if (breakableCells.some((cell) => !cell.active)) {
    throw new Error('At least one contribution cell did not respawn before the animation loop ended');
  }
  if (!idleMode) {
    throw new Error('Ball never reached the seamless return lane');
  }
  if (respawnedHits === 0) {
    throw new Error('Simulation did not collide with any respawned contribution cell');
  }

  const hiddenEventCount = breakableCells.reduce(
    (total, cell) => total + cell.events.filter((event) => !event.active).length,
    0
  );
  if (hiddenEventCount !== totalHits) {
    throw new Error(`Only ${hiddenEventCount}/${totalHits} collisions hide their contribution cell`);
  }

  for (const cell of breakableCells) {
    let expectedActive = true;
    let previousEventAt = -Infinity;
    for (const event of cell.events) {
      if (event.timeMs <= previousEventAt) {
        throw new Error(`${cell.id} contains duplicate or unsorted animation events`);
      }
      expectedActive = !expectedActive;
      if (event.active !== expectedActive) {
        throw new Error(`${cell.id} contains a non-alternating animation event`);
      }
      previousEventAt = event.timeMs;
    }
  }

  const minimumRespawn = Math.min(...respawnDurations);
  const maximumRespawn = Math.max(...respawnDurations);
  if (minimumRespawn < RESPAWN_MIN_MS || maximumRespawn > RESPAWN_HARD_MAX_MS + 1) {
    throw new Error(`Respawn window out of bounds: ${minimumRespawn}ms-${maximumRespawn}ms`);
  }
  const minimumVisibleAfterRespawn = Math.min(...respawnVisibleDurations);
  let maximumFrameTravel = 0;
  for (let index = 1; index < ballFrames.length; index += 1) {
    maximumFrameTravel = Math.max(
      maximumFrameTravel,
      Math.hypot(
        ballFrames[index].x - ballFrames[index - 1].x,
        ballFrames[index].y - ballFrames[index - 1].y
      )
    );
  }
  const maximumAllowedFrameTravel = (BALL_SPEED / FPS) * 2;
  if (maximumFrameTravel > maximumAllowedFrameTravel) {
    throw new Error(`Ball teleported ${formatNumber(maximumFrameTravel, 1)}px between frames`);
  }

  const firstBallFrame = ballFrames[0];
  const lastBallFrame = ballFrames.at(-1);
  const ballLoopGap = Math.hypot(lastBallFrame.x - firstBallFrame.x, lastBallFrame.y - firstBallFrame.y);
  const paddleLoopGap = Math.abs(paddleFrames.at(-1).x - paddleFrames[0].x);
  if (ballLoopGap > 0.01 || paddleLoopGap > 0.01) {
    throw new Error(
      `Animation loop is not seamless: ball ${formatNumber(ballLoopGap, 2)}px, ` +
        `paddle ${formatNumber(paddleLoopGap, 2)}px`
    );
  }

  const trapWindowFrames = Math.round((TRAP_WINDOW_MS / 1000) * FPS);
  const playFrameCount = Math.round((DRAIN_START_MS / 1000) * FPS);
  let minimumTrapMotionSpan = Infinity;
  for (let start = 0; start + trapWindowFrames <= playFrameCount; start += 1) {
    const window = ballFrames.slice(start, start + trapWindowFrames + 1);
    const xs = window.map((frame) => frame.x);
    const ys = window.map((frame) => frame.y);
    const motionSpan = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
    minimumTrapMotionSpan = Math.min(minimumTrapMotionSpan, motionSpan);
  }
  if (minimumTrapMotionSpan < MIN_TRAP_MOTION_SPAN) {
    throw new Error(
      `Ball motion collapsed to ${formatNumber(minimumTrapMotionSpan, 1)}px within ${TRAP_WINDOW_MS}ms`
    );
  }

  return {
    ballFrames,
    paddleFrames,
    totalHits,
    hiddenEventCount,
    respawnedHits,
    respawnEscapeSteers,
    boundaryRecoveries,
    idleEnteredAt,
    activeCellCount: breakableCells.length,
    minimumRespawn,
    maximumRespawn,
    minimumVisibleAfterRespawn,
    minimumTrapMotionSpan,
    maximumFrameTravel,
    ballLoopGap,
    paddleLoopGap,
    paddleGridGap: paddleY - gridBottom
  };
};

const buildMotionAnimation = (frames, valueForFrame) => {
  const lastIndex = frames.length - 1;
  const keyTimes = frames.map((_frame, index) => formatNumber(index / lastIndex, 6)).join(';');
  const values = frames.map(valueForFrame).join(';');
  return `<animateTransform attributeName="transform" type="translate" calcMode="linear" dur="${DURATION_MS}ms" repeatCount="indefinite" keyTimes="${keyTimes}" values="${values}"/>`;
};

const transformSvg = (source, fileName) => {
  const mode = fileName.includes('-dark.') ? 'dark' : 'light';
  const palette = palettes[mode];
  const geometry = parseSvg(source, palette);
  const simulation = simulate(geometry);
  const cellsById = new Map(geometry.cells.map((cell) => [cell.id, cell]));

  let transformed = source.replace(
    /<rect id="c-(\d+)-(\d+)"([^>]*)>([\s\S]*?)<\/rect>/g,
    (cellMarkup, column, row, attributes, content) => {
      const id = `c-${column}-${row}`;
      const cell = cellsById.get(id);
      if (!cell) return cellMarkup;

      const times = [0];
      const values = [cell.initialColor];
      for (const event of cell.events) {
        if (event.timeMs <= 0 || event.timeMs >= DURATION_MS) continue;
        times.push(event.timeMs);
        values.push(event.active ? cell.initialColor : HIDDEN_FILL);
      }
      times.push(DURATION_MS);
      values.push(cell.initialColor);
      const formattedTimes = times.map(formatTime);
      if (new Set(formattedTimes).size !== formattedTimes.length) {
        throw new Error(`${cell.id} contains duplicate serialized keyTimes`);
      }

      let openingTag = `<rect id="${id}"${attributes}>`;
      openingTag = replaceAttribute(openingTag, 'fill', cell.initialColor);
      const animation = `<animate attributeName="fill" calcMode="discrete" dur="${DURATION_MS}ms" repeatCount="indefinite" values="${values.join(';')}" keyTimes="${formattedTimes.join(';')}"/>`;
      const newContent = content.replace(/<animate\s+attributeName="fill"[\s\S]*?\/>/, animation);
      return `${openingTag}${newContent}</rect>`;
    }
  );

  const ballAnimation = buildMotionAnimation(
    simulation.ballFrames,
    (frame) => `${formatNumber(frame.x, 2)},${formatNumber(frame.y, 2)}`
  );
  const paddleAnimation = buildMotionAnimation(
    simulation.paddleFrames,
    (frame) => `${formatNumber(frame.x, 2)},0`
  );

  transformed = transformed
    .replace(
      /<rect id="paddle"[^>]*>/,
      (paddleTag) => replaceAttribute(paddleTag, 'y', formatNumber(geometry.paddleY, 2))
    )
    .replace(
      /(<circle id="ball"[^>]*>)[\s\S]*?(<\/circle>)/,
      `$1${ballAnimation}$2`
    )
    .replace(
      /(<rect id="paddle"[^>]*>)[\s\S]*?(<\/rect>)/,
      `$1${paddleAnimation}$2`
    )
    .replace(/(<circle id="ball"[^>]*\sfill=")[^"]*(")/, `$1${ACCENT}$2`)
    .replace(/(<rect id="paddle"[^>]*\sfill=")[^"]*(")/, `$1${ACCENT}$2`)
    .replace(
      /<desc>[^<]*breakout-contribution-graph[^<]*<\/desc>|<desc>Contribution breakout[^<]*<\/desc>/,
      '<desc>Contribution breakout with seamless motion and collision-safe 30-40 second brick respawns</desc>'
    )
    .replace(
      /<metadata>[\s\S]*?<\/metadata>/,
      `<metadata><info><durationMs>${DURATION_MS}</durationMs><drainStartMs>${DRAIN_START_MS}</drainStartMs><idleEnteredAtMs>${formatNumber(simulation.idleEnteredAt, 1)}</idleEnteredAtMs><loopReturnStartMs>${LOOP_RETURN_START_MS}</loopReturnStartMs><recoveryWindowMs>${DURATION_MS - DRAIN_START_MS}</recoveryWindowMs><paddleGridGap>${formatNumber(simulation.paddleGridGap, 1)}</paddleGridGap><respawnMinMs>${RESPAWN_MIN_MS}</respawnMinMs><respawnMaxMs>${RESPAWN_HARD_MAX_MS}</respawnMaxMs><minimumVisibleAfterRespawnMs>${MIN_RESPAWN_VISIBLE_MS}</minimumVisibleAfterRespawnMs><trapWindowMs>${TRAP_WINDOW_MS}</trapWindowMs><minimumTrapMotionSpan>${MIN_TRAP_MOTION_SPAN}</minimumTrapMotionSpan><activeCells>${simulation.activeCellCount}</activeCells><hits>${simulation.totalHits}</hits><transparentRemovals>${simulation.hiddenEventCount}</transparentRemovals><respawnedCellHits>${simulation.respawnedHits}</respawnedCellHits><respawnEscapeSteers>${simulation.respawnEscapeSteers}</respawnEscapeSteers><boundaryRecoveries>${simulation.boundaryRecoveries}</boundaryRecoveries><observedRespawnMinMs>${formatNumber(simulation.minimumRespawn, 1)}</observedRespawnMinMs><observedRespawnMaxMs>${formatNumber(simulation.maximumRespawn, 1)}</observedRespawnMaxMs><observedMinimumVisibleAfterRespawnMs>${formatNumber(simulation.minimumVisibleAfterRespawn, 1)}</observedMinimumVisibleAfterRespawnMs><observedMinimumTrapMotionSpan>${formatNumber(simulation.minimumTrapMotionSpan, 1)}</observedMinimumTrapMotionSpan><observedMaximumFrameTravel>${formatNumber(simulation.maximumFrameTravel, 2)}</observedMaximumFrameTravel><ballLoopGap>${formatNumber(simulation.ballLoopGap, 3)}</ballLoopGap><paddleLoopGap>${formatNumber(simulation.paddleLoopGap, 3)}</paddleLoopGap></info></metadata>`
    );

  return { svg: transformed, simulation };
};

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('Pass at least one breakout SVG file');

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const result = transformSvg(source, basename(file));
  await writeFile(file, result.svg);
  const stats = result.simulation;
  console.log(
    `${file}: ${stats.hiddenEventCount}/${stats.totalHits} hits turn transparent, ` +
      `${stats.respawnedHits} hits after respawn, ` +
      `${formatNumber(stats.minimumRespawn / 1000, 2)}-${formatNumber(stats.maximumRespawn / 1000, 2)}s observed respawn window, ` +
      `${formatNumber(stats.minimumVisibleAfterRespawn, 1)}ms minimum visible time, ` +
      `${stats.respawnEscapeSteers} anti-trap redirects, ` +
      `${formatNumber(stats.minimumTrapMotionSpan, 1)}px minimum ${TRAP_WINDOW_MS / 1000}s motion span, ` +
      `${formatNumber(stats.maximumFrameTravel, 2)}px max frame travel, ` +
      `${formatNumber(stats.ballLoopGap, 3)}px loop gap, ` +
      `${stats.boundaryRecoveries} boundary recoveries, ` +
      `${formatNumber(stats.paddleGridGap, 1)}px paddle gap`
  );
}
