import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch();
try {
 const page = await browser.newPage();
 const bytes = await page.evaluate(async () => {
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(20), chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
  recorder.ondataavailable = event => chunks.push(event.data);
  const done = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start();
  for (let i = 0; i < 20; i++) {
   ctx.fillStyle = i % 2 ? "#164e63" : "#fde68a"; ctx.fillRect(0,0,320,180);
   ctx.fillStyle = "#ffffff"; ctx.font = "22px sans-serif"; ctx.fillText(`TEST 28/09 · ${i}`, 24, 95);
   await new Promise(resolve => setTimeout(resolve,50));
  }
  recorder.stop(); await done; stream.getTracks().forEach(track => track.stop());
  return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
 });
 await writeFile(process.argv[2] ?? ".release/verification-20260928.webm", Buffer.from(bytes));
 console.log(`Generated ${bytes.length} bytes; synthetic media only.`);
} finally { await browser.close(); }
