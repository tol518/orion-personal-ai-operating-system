import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  assertTransparentSpriteEdges,
  makeSpriteBackgroundTransparent,
} from "./sprite-background.js";

test("removes a connected chroma backdrop without deleting green character details", async () => {
  const canvas = createCanvas(12, 12);
  const context = canvas.getContext("2d");
  context.fillStyle = "#00ff00";
  context.fillRect(0, 0, 12, 12);
  context.fillStyle = "#d94b55";
  context.fillRect(3, 3, 6, 6);
  context.fillStyle = "#00ff00";
  context.fillRect(5, 5, 2, 2);

  const result = await makeSpriteBackgroundTransparent(canvas.toBuffer("image/png"));
  const output = await loadImage(result);
  const outputCanvas = createCanvas(12, 12);
  const outputContext = outputCanvas.getContext("2d");
  outputContext.drawImage(output, 0, 0);
  const pixels = outputContext.getImageData(0, 0, 12, 12).data;

  assert.equal(pixels[3], 0, "outer green backdrop becomes transparent");
  assert.equal(pixels[(4 * 12 + 4) * 4 + 3], 255, "character remains opaque");
  assert.equal(pixels[(5 * 12 + 5) * 4 + 3], 255, "disconnected green character detail remains opaque");
});

test("removes a different connected background from every detected grid cell", async () => {
  const canvas = createCanvas(20, 10);
  const context = canvas.getContext("2d");
  context.fillStyle = "#d7d7d7";
  context.fillRect(0, 0, 10, 10);
  context.fillStyle = "#8fb5d5";
  context.fillRect(10, 0, 10, 10);
  context.fillStyle = "#20252b";
  context.fillRect(3, 2, 4, 6);
  context.fillRect(13, 2, 4, 6);

  const result = await makeSpriteBackgroundTransparent(canvas.toBuffer("image/png"), {
    columns: 2,
    rows: 1,
  });
  const output = await loadImage(result);
  const outputCanvas = createCanvas(20, 10);
  const outputContext = outputCanvas.getContext("2d");
  outputContext.drawImage(output, 0, 0);
  const pixels = outputContext.getImageData(0, 0, 20, 10).data;

  assert.equal(pixels[3], 0, "first cell background becomes transparent");
  assert.equal(pixels[(10 * 4) + 3], 0, "second cell background becomes transparent");
  assert.equal(pixels[(4 * 20 + 4) * 4 + 3], 255, "first character remains opaque");
  assert.equal(pixels[(4 * 20 + 14) * 4 + 3], 255, "second character remains opaque");
  await assert.doesNotReject(() => assertTransparentSpriteEdges(result, { columns: 2, rows: 1 }));
});

test("keeps opaque dark artwork on the edge of an already transparent sheet", async () => {
  const canvas = createCanvas(8, 8);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 8, 8);
  context.fillStyle = "#10141a";
  context.fillRect(0, 3, 4, 3);

  const result = await makeSpriteBackgroundTransparent(canvas.toBuffer("image/png"));
  const output = await loadImage(result);
  const outputCanvas = createCanvas(8, 8);
  const outputContext = outputCanvas.getContext("2d");
  outputContext.drawImage(output, 0, 0);
  const pixels = outputContext.getImageData(0, 0, 8, 8).data;

  assert.equal(pixels[(4 * 8) * 4 + 3], 255);
});

test("rejects a sprite sheet whose cell borders remain opaque", async () => {
  const canvas = createCanvas(12, 12);
  const context = canvas.getContext("2d");
  context.fillStyle = "#59616b";
  context.fillRect(0, 0, 12, 12);

  await assert.rejects(
    () => assertTransparentSpriteEdges(canvas.toBuffer("image/png")),
    /could not be removed cleanly/,
  );
});
