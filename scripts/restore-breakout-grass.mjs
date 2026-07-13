import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DURATION_MS = 90_000;
const RESPAWN_MIN_MS = 10_000;
const RESPAWN_TARGET_MAX_MS = 19_000;
const RESPAWN_HARD_MAX_MS = 20_000;
const RESPAWN_FORCE_MS = 19_950;
const BREAKABLE_UNTIL_MS = DURATION_MS - RESPAWN_HARD_MAX_MS;
const FPS = 30;
const BALL_SPEED = 235;
const PADDLE_SPEED = 900;
const ACCENT = '#B6F13A';

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
  const paddleY = Number(getAttribute(paddleTag, 'y'));
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
      respawnEligibleAt: null
    });
  }

  if (cells.length !== 371) {
    throw new Error(`Expected 371 contribution cells, found ${cells.length}`);
  }

  return { width, height, ballRadius, paddleY, paddleWidth, paddleHeight, cells };
};

const simulate = (geometry) => {
  const { width, height, ballRadius, paddleY, paddleWidth, paddleHeight, cells } = geometry;
  const breakableCells = cells.filter((cell) => cell.breakable);
  if (breakableCells.length === 0) throw new Error('No active contribution cells found');

  const gridTop = Math.min(...cells.map((cell) => cell.y));
  const ball = {
    x: width / 2,
    y: paddleY - ballRadius - 2,
    vx: 0,
    vy: -BALL_SPEED
  };
  let paddleX = clamp(ball.x - paddleWidth / 2, 0, width - paddleWidth);
  let targetCursor = 0;
  let totalHits = 0;
  let respawnedHits = 0;
  const respawnDurations = [];

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

  const ballFrames = [{ x: ball.x, y: ball.y }];
  const paddleFrames = [{ x: paddleX }];
  aimBallUpward();

  const totalFrames = Math.round((DURATION_MS / 1000) * FPS);
  const frameSeconds = 1 / FPS;

  for (let frame = 1; frame <= totalFrames; frame += 1) {
    const paddleTarget = clamp(ball.x - paddleWidth / 2, 0, width - paddleWidth);
    const paddleStep = PADDLE_SPEED * frameSeconds;
    paddleX += clamp(paddleTarget - paddleX, -paddleStep, paddleStep);

    const travelDistance = Math.hypot(ball.vx, ball.vy) * frameSeconds;
    const subSteps = Math.max(1, Math.ceil(travelDistance / Math.max(ballRadius * 0.45, 1)));
    const subSeconds = frameSeconds / subSteps;

    for (let subStep = 0; subStep < subSteps; subStep += 1) {
      const timeMs = ((frame - 1) + (subStep + 1) / subSteps) * frameSeconds * 1000;

      for (const cell of breakableCells) {
        if (cell.active || cell.respawnEligibleAt === null || timeMs < cell.respawnEligibleAt) continue;
        const maximumRespawnAt = cell.lastHitAt + RESPAWN_FORCE_MS;
        if (!circleIntersectsCell(ball, cell, ballRadius) || timeMs >= maximumRespawnAt) {
          cell.active = true;
          cell.lastRespawnAt = timeMs;
          cell.respawnEligibleAt = null;
          cell.events.push({ timeMs, active: true });
          respawnDurations.push(timeMs - cell.lastHitAt);
        }
      }

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

      if (
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
        if (timeMs <= BREAKABLE_UNTIL_MS) {
          const hitAfterRespawn = cell.lastRespawnAt !== null;
          cell.active = false;
          cell.events.push({ timeMs, active: false });
          cell.hitCount += 1;
          cell.lastHitAt = timeMs;
          cell.respawnEligibleAt = timeMs + respawnDelay(cell);
          totalHits += 1;
          if (hitAfterRespawn) respawnedHits += 1;
        }
        break;
      }

      if (ball.y - ballRadius > height) {
        ball.x = width / 2;
        ball.y = paddleY - ballRadius - 2;
        aimBallUpward();
      }
    }

    ballFrames.push({ x: ball.x, y: ball.y });
    paddleFrames.push({ x: paddleX });
  }

  if (breakableCells.some((cell) => !cell.active)) {
    throw new Error('At least one contribution cell did not respawn before the animation loop ended');
  }
  if (respawnedHits === 0) {
    throw new Error('Simulation did not collide with any respawned contribution cell');
  }

  const minimumRespawn = Math.min(...respawnDurations);
  const maximumRespawn = Math.max(...respawnDurations);
  if (minimumRespawn < RESPAWN_MIN_MS || maximumRespawn > RESPAWN_HARD_MAX_MS + 1) {
    throw new Error(`Respawn window out of bounds: ${minimumRespawn}ms-${maximumRespawn}ms`);
  }

  return {
    ballFrames,
    paddleFrames,
    totalHits,
    respawnedHits,
    activeCellCount: breakableCells.length,
    minimumRespawn,
    maximumRespawn
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
        values.push(event.active ? cell.initialColor : palette.none);
      }
      times.push(DURATION_MS);
      values.push(cell.initialColor);

      let openingTag = `<rect id="${id}"${attributes}>`;
      openingTag = replaceAttribute(openingTag, 'fill', cell.initialColor);
      const animation = `<animate attributeName="fill" calcMode="discrete" dur="${DURATION_MS}ms" repeatCount="indefinite" values="${values.join(';')}" keyTimes="${times.map(formatTime).join(';')}"/>`;
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
      '<desc>Contribution breakout with physical 10-20 second brick respawns</desc>'
    )
    .replace(
      /<metadata>[\s\S]*?<\/metadata>/,
      `<metadata><info><durationMs>${DURATION_MS}</durationMs><respawnMinMs>${RESPAWN_MIN_MS}</respawnMinMs><respawnMaxMs>${RESPAWN_HARD_MAX_MS}</respawnMaxMs><activeCells>${simulation.activeCellCount}</activeCells><hits>${simulation.totalHits}</hits><respawnedCellHits>${simulation.respawnedHits}</respawnedCellHits><observedRespawnMinMs>${formatNumber(simulation.minimumRespawn, 1)}</observedRespawnMinMs><observedRespawnMaxMs>${formatNumber(simulation.maximumRespawn, 1)}</observedRespawnMaxMs></info></metadata>`
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
    `${file}: ${stats.totalHits} hits, ${stats.respawnedHits} hits after respawn, ` +
      `${formatNumber(stats.minimumRespawn / 1000, 2)}-${formatNumber(stats.maximumRespawn / 1000, 2)}s observed respawn window`
  );
}
