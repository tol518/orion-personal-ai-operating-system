import { createCanvas, loadImage } from "@napi-rs/canvas";

const CHROMA_MIN_GREEN = 145;
const CORNER_DISTANCE = 72;

export async function makeSpriteBackgroundTransparent(source, animationSpec = { columns: 1, rows: 1 }) {
  const image = await loadImage(source);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  const { data } = pixels;
  const width = image.width;
  const height = image.height;
  const columns = Math.max(1, Number(animationSpec?.columns) || 1);
  const rows = Math.max(1, Number(animationSpec?.rows) || 1);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = Math.floor((column * width) / columns);
      const right = Math.floor(((column + 1) * width) / columns) - 1;
      const top = Math.floor((row * height) / rows);
      const bottom = Math.floor(((row + 1) * height) / rows) - 1;
      removeCellBackdrop({ data, width, visited, queue, left, right, top, bottom });
    }
  }

  context.putImageData(pixels, 0, 0);
  return canvas.toBuffer("image/png");
}

export async function assertTransparentSpriteEdges(source, animationSpec = { columns: 1, rows: 1 }) {
  const image = await loadImage(source);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  const columns = Math.max(1, Number(animationSpec?.columns) || 1);
  const rows = Math.max(1, Number(animationSpec?.rows) || 1);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = Math.floor((column * image.width) / columns);
      const right = Math.floor(((column + 1) * image.width) / columns) - 1;
      const top = Math.floor((row * image.height) / rows);
      const bottom = Math.floor(((row + 1) * image.height) / rows) - 1;
      const edge = cellEdgeOpacity(data, image.width, left, right, top, bottom);
      if (edge.opaque / edge.total > 0.25) {
        throw Object.assign(
          new Error("The sprite background could not be removed cleanly. Upload a sheet with a transparent, solid, or simple gradient background."),
          { statusCode: 422 },
        );
      }
    }
  }
}

function removeCellBackdrop({ data, width, visited, queue, left, right, top, bottom }) {
  const key = averageCellCorners(data, width, left, right, top, bottom);
  let read = 0;
  let write = 0;

  const enqueue = (x, y) => {
    if (x < left || x > right || y < top || y > bottom) return;
    const index = y * width + x;
    if (visited[index]) return;
    visited[index] = 1;
    if (!matchesBackdrop(data, index * 4, key)) return;
    queue[write++] = index;
  };

  for (let x = left; x <= right; x += 1) {
    enqueue(x, top);
    enqueue(x, bottom);
  }
  for (let y = top + 1; y < bottom; y += 1) {
    enqueue(left, y);
    enqueue(right, y);
  }

  while (read < write) {
    const index = queue[read++];
    data[index * 4 + 3] = 0;
    const x = index % width;
    const y = Math.floor(index / width);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }
}

function averageCellCorners(data, width, left, right, top, bottom) {
  const samples = [top * width + left, top * width + right, bottom * width + left, bottom * width + right];
  const total = samples.reduce(
    (sum, index) => {
      const offset = index * 4;
      return [
        sum[0] + data[offset],
        sum[1] + data[offset + 1],
        sum[2] + data[offset + 2],
        sum[3] + data[offset + 3],
      ];
    },
    [0, 0, 0, 0],
  );
  return total.map((value) => value / samples.length);
}

function cellEdgeOpacity(data, width, left, right, top, bottom) {
  const thickness = Math.max(1, Math.floor(Math.min(right - left + 1, bottom - top + 1) * 0.02));
  let opaque = 0;
  let total = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const onEdge = x < left + thickness || x > right - thickness || y < top + thickness || y > bottom - thickness;
      if (!onEdge) continue;
      total += 1;
      if (data[(y * width + x) * 4 + 3] > 32) opaque += 1;
    }
  }
  return { opaque, total };
}

function matchesBackdrop(data, offset, key) {
  if (data[offset + 3] === 0) return true;
  if (key[3] < 64) return false;
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const chromaGreen =
    green >= CHROMA_MIN_GREEN && green > red * 1.35 && green > blue * 1.25;
  const distance = Math.hypot(red - key[0], green - key[1], blue - key[2]);
  return chromaGreen || distance <= CORNER_DISTANCE;
}
