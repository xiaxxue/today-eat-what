const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const outputDir = join(__dirname, 'dist');
mkdirSync(outputDir, { recursive: true });
copyFileSync(join(__dirname, 'index.html'), join(outputDir, 'index.html'));
copyFileSync(join(__dirname, 'app.js'), join(outputDir, 'app.js'));

console.log('static site built in dist/');
