import fs from 'fs/promises';
import chalk from 'chalk';

async function getJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf-8'));
  } catch (e) {
    return null;
  }
}

const seo = await getJson('./localhost3000.seo.json');
const crawlResult = await getJson('./localhost3000.json');

for (const [url, meta] of Object.entries(seo)) {

  const brokenUrls = new Set();
  const pendingUrls = new Set();
  const unvisitedUrls = new Set();
  const badUrls = new Set();

  for (let url of meta.anchors) {
    try {
      url = normalizeExternalUrl(url);
    } catch (e) {
      // badUrls.add(url);
      continue;
    }

    if (crawlResult.pendingUrls.includes(url)) {
      pendingUrls.add(url);
      continue;
    }

    if (crawlResult.unreachableUrls.includes(url)) {
      brokenUrls.add(url);
      continue;
    }

    if (!crawlResult.visitedUrls.includes(url)) {
      unvisitedUrls.add(url);
    }
  }

  if (brokenUrls.size === 0 && unvisitedUrls.size === 0 && badUrls.size === 0 && pendingUrls.size === 0) {
    continue;
  }

  console.log('broken links on', url, ':');
  for (const brokenUrl of brokenUrls) {
    console.log(`\t404: ${chalk.red(brokenUrl)}`);
  }
  for (const pendingUrl of pendingUrls) {
    console.log(`\tPENDING: ${chalk.blue(pendingUrl)}`);
  }
  for (const unvisitedUrl of unvisitedUrls) {
    console.log(`\tNO META: ${chalk.magenta(unvisitedUrl)}`);
  }
  for (const badUrl of badUrls) {
    console.log(`\tBAD URL: ${chalk.red(JSON.stringify(badUrl))}`);
  }
  console.log();
}

function normalizeExternalUrl(urlStr) {
  const url = new URL(urlStr);


  url.hash = '';
  url.md4 = '';

  return url.toString();
}
