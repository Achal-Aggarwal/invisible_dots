// The README animation, rebuilt from its pieces: photos -> frames -> GIFs.
//
//   1. photos  cut_out.py turns photos/characters.png into one cut-out per theme
//   2. frames  each page in html/ composes the photos; renderLoop(t) draws the
//              frame at second t, and Chromium takes a screenshot of it, 12 a second
//   3. GIFs    ffmpeg turns each run of frames into docs/images/hero-*.gif
//
// html/social.html is a page of one frame: the repository's social preview, written
// to docs/images/social-preview.png.
//
//   node docs/hero/build.mjs                 everything
//   node docs/hero/build.mjs wide social     only those pieces (wide, mobile, small, social)
//
// Needs the repository's node_modules (Playwright comes with apps/web), Python with
// Pillow, NumPy and SciPy, and ffmpeg on PATH. The pages use Segoe UI and Consolas,
// so the GIFs come out identical only on Windows.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const { chromium } = createRequire(path.join(ROOT, "package.json"))("@playwright/test");

const FPS = 12;
const LAYOUTS = {
  wide: { page: "wide.html", width: 1280, height: 470, gif: "hero" },
  mobile: { page: "mobile.html", width: 720, height: 620, gif: "hero-mobile" },
  small: { page: "small.html", width: 720, height: 620, gif: "hero-small" },
};
const THEMES = ["light", "dark"];
// Pictures of one frame. The social preview is uploaded by hand in the repository's
// Settings, so it is written where it can be found for that.
const STILLS = {
  social: { page: "social.html", width: 1280, height: 640, out: "social-preview.png" },
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
}

const wanted = process.argv.slice(2);
const known = [...Object.keys(LAYOUTS), ...Object.keys(STILLS)];
for (const name of wanted) if (!known.includes(name)) throw new Error(`unknown piece ${name}: ${known.join(", ")}`);
const layouts = (wanted.length ? wanted : Object.keys(LAYOUTS)).filter((n) => LAYOUTS[n]);
const stills = (wanted.length ? wanted : Object.keys(STILLS)).filter((n) => STILLS[n]);

// 1. photos
run(process.platform === "win32" ? "python" : "python3", [path.join(HERE, "cut_out.py")]);

const browser = await chromium.launch();
try {
  for (const name of layouts) {
    const { page: file, width, height, gif } = LAYOUTS[name];
    for (const theme of THEMES) {
      // 2. frames
      const dir = path.join(HERE, "frames", `${name}-${theme}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      // ?frames stops the page's own playback: every frame is the one renderLoop(t) drew
      await page.goto(`${pathToFileURL(path.join(HERE, "html", file)).href}?theme=${theme}&frames`);
      await page.waitForLoadState("load");
      const seconds = await page.evaluate(() => window.LOOP_SECONDS);
      const count = Math.round(seconds * FPS);
      for (let i = 0; i < count; i++) {
        await page.evaluate((t) => window.renderLoop(t), i / FPS);
        await page.screenshot({ path: path.join(dir, `f${String(i).padStart(5, "0")}.png`) });
      }
      await page.close();

      // 3. GIF: one palette for the whole loop, built from every frame
      const out = path.join(ROOT, "docs", "images", `${gif}-${theme}.gif`);
      run("ffmpeg", [
        "-v", "error", "-y", "-framerate", String(FPS), "-i", path.join(dir, "f%05d.png"),
        "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
        "-loop", "0", out,
      ]);
      console.log(`${path.relative(ROOT, out)}: ${count} frames, ${seconds}s`);
    }
  }
  for (const name of stills) {
    const { page: file, width, height, out: picture } = STILLS[name];
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(HERE, "html", file)).href);
    await page.waitForLoadState("load");
    const out = path.join(ROOT, "docs", "images", picture);
    await page.screenshot({ path: out });
    await page.close();
    console.log(`${path.relative(ROOT, out)}: ${width}x${height}`);
  }
} finally {
  await browser.close();
}
