import { chromium } from 'playwright';
import * as path from 'path';

async function generatePdf() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const htmlPath = path.resolve(__dirname, '../../test-results/bdd/index.html');
  
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.pdf({
    path: 'test-results/bdd/documentation.pdf',
    format: 'A4',
    printBackground: true,
    margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' }
  });

  await browser.close();
  console.log('PDF documentation generated: test-results/bdd/documentation.pdf');
}

generatePdf().catch(console.error);
