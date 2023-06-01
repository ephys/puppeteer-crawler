#!/usr/bin/env node

import fs from 'node:fs/promises';
import chalk from 'chalk';

async function getJson(filename: string): Promise<unknown> {
  try {
    // @ts-expect-error -- typescript is wrong here
    return JSON.parse(await fs.readFile(filename));
  } catch {
    return null;
  }
}

interface Metadata {
  title: string;
  'twitter:card': string;
  'og:url': string;
  'og:title': string;
  'og:description': string;
  description: string;
  redirectedFrom: string[];
  anchors: string[];
  hash: string;
}

const seo = await getJson('./localhost3000.seo.json') as Record</* url */ string, Metadata>;
const crawlResult = await getJson('./localhost3000.json') as {
  visitedUrls: string[],
  pendingUrls: string[],
  unreachableUrls: string[],
  externalUrls: string[],
};

for (const [url, meta] of Object.entries(seo)) {

  const brokenUrls = new Set();
  const pendingUrls = new Set();
  const unvisitedUrls = new Set();
  const badUrls = new Set();

  for (let anchor of meta.anchors) {
    try {
      anchor = normalizeExternalUrl(anchor);
    } catch {
      // badUrls.add(url);
      continue;
    }

    if (crawlResult.pendingUrls.includes(anchor)) {
      pendingUrls.add(anchor);
      continue;
    }

    if (crawlResult.unreachableUrls.includes(anchor)) {
      brokenUrls.add(anchor);
      continue;
    }

    if (!crawlResult.visitedUrls.includes(anchor)) {
      unvisitedUrls.add(anchor);
    }
  }

  if (brokenUrls.size === 0 && unvisitedUrls.size === 0 && badUrls.size === 0 && pendingUrls.size === 0) {
    continue;
  }

  console.info('broken links on', url, ':');
  for (const brokenUrl of brokenUrls) {
    console.info(`\t404: ${chalk.red(brokenUrl)}`);
  }

  for (const pendingUrl of pendingUrls) {
    console.info(`\tPENDING: ${chalk.blue(pendingUrl)}`);
  }

  for (const unvisitedUrl of unvisitedUrls) {
    console.info(`\tNO META: ${chalk.magenta(unvisitedUrl)}`);
  }

  for (const badUrl of badUrls) {
    console.info(`\tBAD URL: ${chalk.red(JSON.stringify(badUrl))}`);
  }

  console.info();
}

function normalizeExternalUrl(urlStr) {
  const url = new URL(urlStr);

  url.hash = '';

  return url.toString();
}
