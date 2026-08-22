const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const outputDir = join(__dirname, 'dist');
mkdirSync(outputDir, { recursive: true });
copyFileSync(join(__dirname, 'index.html'), join(outputDir, 'index.html'));
copyFileSync(join(__dirname, 'app.js'), join(outputDir, 'app.js'));
copyFileSync(
  join(__dirname, '10b7c4affc7aba2d71789e7834748003.txt'),
  join(outputDir, '10b7c4affc7aba2d71789e7834748003.txt'),
);

console.log('static site built in dist/');
