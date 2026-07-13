import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const RESPAWN_MS = 600;
const ACCENT = '#B6F13A';
const FLASH = '#F1FFC2';

const palettes = {
  light: new Map([
    ['#ebedf0', '#EBEDF0'],
    ['#9be9a8', '#D9F99D'],
    ['#40c463', '#BEF264'],
    ['#30a14e', '#84CC16'],
    ['#216e39', '#3F6212']
  ]),
  dark: new Map([
    ['#161b22', '#161B22'],
    ['#0e4429', '#365314'],
    ['#006d32', '#4D7C0F'],
    ['#26a641', '#84CC16'],
    ['#39d353', '#BEF264']
  ])
};

const formatTime = (value) => {
  if (value <= 0) return '0';
  if (value >= 1) return '1';
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
};

const replaceAttribute = (tag, name, value) =>
  tag.replace(new RegExp(`${name}="[^"]*"`), `${name}="${value}"`);

const transformSvg = (source, fileName) => {
  const mode = fileName.includes('-dark.') ? 'dark' : 'light';
  const palette = palettes[mode];
  let cellCount = 0;
  let animatedCellCount = 0;

  const transformed = source.replace(
    /<rect id="c-(\d+)-(\d+)"([^>]*)>([\s\S]*?)<\/rect>/g,
    (cell, _x, _y, attributes, content) => {
      const animation = content.match(/<animate\s+attributeName="fill"[\s\S]*?\/>/);
      if (!animation) return cell;

      const duration = animation[0].match(/dur="([\d.]+)ms"/);
      const values = animation[0].match(/values="([^"]*)"/);
      const keyTimes = animation[0].match(/keyTimes="([^"]*)"/);
      if (!duration || !values || !keyTimes) return cell;

      const durationMs = Number(duration[1]);
      const sourceValues = values[1].split(';');
      const sourceTimes = keyTimes[1].split(';').map(Number);
      if (!Number.isFinite(durationMs) || sourceValues.length !== sourceTimes.length) return cell;

      const initialColor = palette.get(sourceValues[0].toLowerCase()) ?? sourceValues[0];
      const hitTimes = sourceTimes.filter((time, index) => {
        if (index === 0 || time <= 0 || time >= 1) return false;
        return sourceValues[index] !== sourceValues[index - 1];
      });

      const newTimes = [0];
      const newValues = [initialColor];
      const respawnRatio = RESPAWN_MS / durationMs;

      hitTimes.forEach((hitTime, index) => {
        const nextHit = hitTimes[index + 1] ?? 1;
        const restoreTime = Math.min(hitTime + respawnRatio, nextHit - 0.000001, 0.999999);

        newTimes.push(hitTime);
        newValues.push(FLASH);

        if (restoreTime > hitTime) {
          newTimes.push(restoreTime);
          newValues.push(initialColor);
        }
      });

      if (newTimes.at(-1) !== 1) {
        newTimes.push(1);
        newValues.push(initialColor);
      }

      let openingTag = `<rect id="c-${_x}-${_y}"${attributes}>`;
      openingTag = replaceAttribute(openingTag, 'fill', initialColor);

      let newAnimation = replaceAttribute(animation[0], 'values', newValues.join(';'));
      newAnimation = replaceAttribute(newAnimation, 'keyTimes', newTimes.map(formatTime).join(';'));

      cellCount += 1;
      if (hitTimes.length > 0) animatedCellCount += 1;

      return `${openingTag}${content.replace(animation[0], newAnimation)}</rect>`;
    }
  );

  if (cellCount !== 371) {
    throw new Error(`${fileName}: expected 371 contribution cells, found ${cellCount}`);
  }
  if (animatedCellCount === 0) {
    throw new Error(`${fileName}: no contribution hits were found`);
  }

  const withAccent = transformed
    .replace(/(<circle id="ball"[^>]*\sfill=")[^"]*(")/, `$1${ACCENT}$2`)
    .replace(/(<rect id="paddle"[^>]*\sfill=")[^"]*(")/, `$1${ACCENT}$2`)
    .replace(
      /<desc>[^<]*breakout-contribution-graph[^<]*<\/desc>/,
      `<desc>Contribution breakout with ${RESPAWN_MS}ms grass respawn</desc>`
    );

  return { svg: withAccent, cellCount, animatedCellCount };
};

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error('Pass at least one breakout SVG file');
}

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const result = transformSvg(source, basename(file));
  await writeFile(file, result.svg);
  console.log(`${file}: restored ${result.animatedCellCount}/${result.cellCount} cells after each hit`);
}
