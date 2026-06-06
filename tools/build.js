const { build, buildSync } = require("esbuild");
const path = require("path");
const fs = require("fs");
// const fse = require('fs-extra');
const configAll = require('./build-config');


(async () => {
  try {
    let buildEvn = process.env.NODE_ENV
    let config = buildEvn == "production" ? configAll.build : configAll.build

    if (buildEvn !== "production") {
      config = configAll.dev
    }

    const timerStart = Date.now();
    // Backup old dist file before deleting (stored outside dist/ to survive rmSync)
    const distDir = path.dirname(config.outfile);
    const backupDir = path.join(path.dirname(distDir), 'dist-backups');
    if (fs.existsSync(config.outfile)) {
      const oldContent = fs.readFileSync(config.outfile, 'utf-8');
      const versionMatch = oldContent.match(/@version\s+(\S+)/);
      if (versionMatch && versionMatch[1]) {
        const oldVer = versionMatch[1];
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(config.outfile, path.join(backupDir, `aiplugin4-v${oldVer}.js`));
      }
    }
    fs.rmSync(distDir, { recursive: true, force: true });
    // fse.copySync("./assets", path.join(path.dirname(config.outfile), "assets"), { overwrite: true });
    // fs.copyFileSync("./index.html", path.join(path.dirname(config.outfile), "index.html"));
    // fs.copyFileSync(buildEvn == "production" ? "./index.html" : "./indexDebug.html", path.join(path.dirname(config.outfile), "index.html"));

    // config.incremental = false;
    await buildSync(config);
    const bodyText = fs.readFileSync(config.outfile);
    const headerText = fs.readFileSync('./header.txt').toString();
    fs.writeFileSync(config.outfile, `${headerText}\n${bodyText}`);
    const timerEnd = Date.now();
    console.log(`🔨 Built in ${timerEnd - timerStart}ms.`)
    process.exit(0);
  } catch (e) {
    console.error(e);
  }
})()
