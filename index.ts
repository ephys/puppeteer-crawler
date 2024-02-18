#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import lighthouse from 'lighthouse';
import uniq from 'lodash/uniq.js';
import meow from 'meow';
import micromatch from 'micromatch';
import type { Browser, Target } from 'puppeteer';
import puppeteer, { BrowserContextEmittedEvents } from 'puppeteer';
import { retryAsPromised } from 'retry-as-promised';

// TODO: respect noindex/nofollow if flag is set
// TODO: use sitemap.xml
// TODO: collect robots.txt
// TODO: log redirection chains
// TODO: if a page has the same MD5 as another, tag them as "potential canonicals" & warn if they're not tagged as canonicals of one-another
// TODO: run lighthouse mobile + desktop
// TODO: check if #anchor exists?
// TODO: remove anchor when requesting a page?

// TODO: normalization:
//  - handle rel=alternate
//  - handle rel=canonical
//  - normalize trailing /
//  - normalize based on redirection
// TODO: handle http 304

function md4(text) {
  return crypto.createHash('md4').update(text).digest('hex');
}

const cliName = path.relative(process.cwd(), process.argv[1]);

const validMetaTypes = ['anchors', 'resources', 'lighthouse'];

const cli = meow(`
  Usage
    $ ${cliName} <url>

  Options
    --check-externals      Checks whether the external links are still alive
    --only-path            If set, only these paths will be crawled. All others will be treated as external. Can be provided multiple times. Micromatch syntax.
    --exclude-path         If set, these paths will be treated as external. Can be provided multiple times. Micromatch syntax.
    --domain-alias <url>   Add an extra domain that the scraper can consider as being the same domain as the base url.
    --collect-meta <types> Collect metadata of crawled webpages. Types: ${validMetaTypes.join(', ')} (comma-separated).
    --delay <delay>        Pause time between two page fetches in ms (default to 500ms).
    --lighthouse           Run lighthouse on crawled pages.

  Examples
    $ ${cliName} https://example.com --domain-alias https://www.example.com
`, {
  importMeta: import.meta,
  flags: {
    onlyPath: {
      type: 'string',
      isMultiple: true,
      default: [],
    },
    excludePath: {
      type: 'string',
      isMultiple: true,
      default: [],
    },
    checkExternals: {
      type: 'boolean',
      default: false,
    },
    domainAlias: {
      type: 'string',
    },
    collectMeta: {
      type: 'string',
      default: '',
    },
    delay: {
      type: 'string',
      inferType: true,
      default: '500',
    },
  },
});

async function run() {
  let browser;
  try {
    const initialUrl = cli.input[0];
    if (!initialUrl) {
      cli.showHelp();

      return;
    }

    const outDir = `${process.cwd()}/out`;
    await fs.mkdir(outDir, { recursive: true });

    const canonicalHost = (new URL(initialUrl)).host;
    const stateFile = `${outDir}/${slugify(canonicalHost)}.json`;
    const metaFile = `${outDir}/${slugify(canonicalHost)}.meta.json`;

    const delay = Number(cli.flags.delay);
    const collectMetaTypes = cli.flags.collectMeta.trim().split(',').filter(Boolean);

    for (const collectableMetaPart of collectMetaTypes) {
      if (!validMetaTypes.includes(collectableMetaPart)) {
        throw new Error(`${collectableMetaPart} is not a valid meta type (expected one or multiple of ${validMetaTypes.join(', ')} separated by a comma)`);
      }
    }

    const collectMeta = collectMetaTypes.length > 0;
    const collectLighthouse = collectMetaTypes.includes('lighthouse');

    const internalPatterns = !cli.flags.includePath ? []
      : Array.isArray(cli.flags.includePath) ? cli.flags.includePath
        : [cli.flags.includePath];

    const externalPatterns = !cli.flags.excludePath ? []
      : Array.isArray(cli.flags.excludePath) ? cli.flags.excludePath
        : [cli.flags.excludePath];

    const validDomains = !cli.flags.domainAlias ? []
      : Array.isArray(cli.flags.domainAlias) ? cli.flags.domainAlias
        : [cli.flags.domainAlias];
    const checkExternals = cli.flags.checkExternals;

    validDomains.push(initialUrl);

    const isExternalUrl = urlStr => {
      const urlObj = new URL(urlStr);

      if (!isSameDomain(validDomains, urlStr)) {
        return true;
      }

      if (micromatch.any(urlObj.pathname, externalPatterns)) {
        return true;
      }

      return internalPatterns.length > 0 && !micromatch.all(urlObj.pathname, internalPatterns);
    };

    console.info(`SAVING STATE TO ${stateFile}`);
    if (collectMeta) {
      console.info(`SAVING METADATA TO ${metaFile}`);
    }

    const initialState = await getInitialState(stateFile);
    const metaState = collectMeta ? await getInitialState(metaFile) || {} : null;

    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    console.info('Running on', await browser.version());

    const visitedUrls = new Set<string>(initialState && initialState.visitedUrls || []);
    const pendingUrls = new Set<string>(initialState && initialState.pendingUrls || [initialUrl]);
    const externalUrls = new Set<string>(initialState && initialState.externalUrls || []);
    const unreachableUrls = new Set<string>(initialState && initialState.unreachableUrls || []);

    // retry unreachable urls
    for (const url of unreachableUrls) {
      unreachableUrls.delete(url);
      pendingUrls.add(url);
    }

    if (collectMeta) {
      let moved = 0;

      for (const url of visitedUrls) {
        if (!metaState[url]) {
          visitedUrls.delete(url);
          pendingUrls.add(url);
          moved++;
        }
      }

      if (moved > 0) {
        console.info(`Re-crawling ${moved} urls as their metadata was not crawled`);
      }
    }

    // reduce requests
    // await page.setRequestInterception(true);

    normalizeUrlSet(visitedUrls, canonicalHost);
    normalizeUrlSet(pendingUrls, canonicalHost);
    // we don't normalize external urls as we can't assume anything about other websites

    while (pendingUrls.size > 0) {

      await setTimeout(delay);

      const visitingUrl = pendingUrls.values().next().value;
      const isVisitingExternal = isExternalUrl(visitingUrl);
      const pageMeta = Object.create(null);

      console.info(isVisitingExternal ? '[VISITING EXTERNAL]' : '[VISITING]', visitingUrl);

      const logRequests = request => {
        /*
         document, stylesheet, image, media, font, script, texttrack, xhr, fetch, eventsource, websocket, manifest, other
         */

        if (collectMeta) {
          const url = request.url();
          const type = request.resourceType();

          if (['image', 'stylesheet', 'font', 'media', 'script'].includes(type)) {
            pageMeta[type] = pageMeta[type] || [];

            pageMeta[type].push(url);
          } else {
            console.warn('Untracked request', type, url);
          }
        }
      };

      try {
        if (collectMetaTypes.includes('resources')) {
          page.on('request', logRequests);
        }

        let redirectionChain;
        let visitingUrls;
        let finalUrl;
        try {
          // if we collect metadata: we wait for page to be fully loaded as we collect the list of referenced resources
          const response = await retryAsPromised(async () => {
            const res = await page.goto(visitingUrl, collectMetaTypes.includes('resources') ? { waitUntil: 'networkidle2' } : undefined);

            if (!res.ok() && res.status() !== 404) {
              throw new Error(`Resource responded with ${res.status()}`);
            }

            return res;
          }, {
            max: 3,
            backoffBase: 1000,
            backoffExponent: 1.5,
          });

          redirectionChain = response.request().redirectChain().map(request => request.url());
          finalUrl = response.url();

          visitingUrls = [...redirectionChain, finalUrl];

          if (!response.ok()) {
            console.error('[COULD NOT NAVIGATE]', visitingUrl, `(${response.status()})`);
            for (const url of visitingUrls) {
              unreachableUrls.add(url);
              pendingUrls.delete(url);
            }

            continue;
          }
        } catch (error) {
          console.error('[COULD NOT NAVIGATE]', visitingUrl, `(${error.message})`);
          unreachableUrls.add(visitingUrl);
          pendingUrls.delete(visitingUrl);
          continue;
        }

        if (!isVisitingExternal) {
          // eslint-disable-next-line @typescript-eslint/no-loop-func
          const { anchors, meta: extractedMeta } = await page.evaluate(() => {
            const pageAnchors = [...document.querySelectorAll('a')].map(anchor => anchor.href);

            const metaTags = document.querySelectorAll('meta[name="robots"], meta[name="description"], meta[name="keywords"], meta[property^="og:"], meta[name^="twitter:"]');
            const metaMapping = {};
            for (const metaTag of metaTags) {
              const name = metaTag.getAttribute('name') || metaTag.getAttribute('property');
              if (!('content' in metaTag)) {
                continue;
              }

              metaMapping[name] = metaTag.content;
            }

            const meta = {
              title: document.title,
              ...metaMapping,
            };

            return {
              anchors: pageAnchors,
              meta,
            };
          });

          if (collectMeta) {
            const pageHash = md4(await page.content());
            let lighthouseScore;
            if (collectLighthouse) {
              lighthouseScore = await runLighthouse(browser, finalUrl);
            }

            if (metaState[finalUrl]) {
              metaState[finalUrl].redirectedFrom = metaState[finalUrl].redirectedFrom ?? [];
              metaState[finalUrl].redirectedFrom.push(...redirectionChain);
              uniq(metaState[finalUrl].redirectedFrom);
            } else {
              metaState[finalUrl] = Object.assign(pageMeta, extractedMeta, {
                redirectedFrom: redirectionChain,
                anchors: uniq(anchors),
                lighthouse: lighthouseScore,
                hash: pageHash,
              });
            }

            saveState(metaFile, metaState);
          }

          for (const url of anchors) {
            if (!url) {
              continue;
            }

            const isExternal = isExternalUrl(url);

            const normalized = isExternal ? normalizeExternalUrl(url) : normalizeUrl(url, canonicalHost);

            if (isExternal) {
              externalUrls.add(url);
            }

            if ((!isExternal || checkExternals) && !visitedUrls.has(normalized) && !pendingUrls.has(normalized)) {
              pendingUrls.add(normalized);

              console.info('[DISCOVERED]', normalized);
            }
          }
        }

        for (const url of visitingUrls) {
          visitedUrls.add(url);
          pendingUrls.delete(url);
        }

        saveState(stateFile, { visitedUrls, pendingUrls, externalUrls, unreachableUrls });
      } finally {
        page.off('request', logRequests);
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function normalizeUrlSet(urlSet, canonicalHost) {
  for (const url of urlSet) {
    const normalized = normalizeUrl(url, canonicalHost);
    if (normalized !== url) {
      urlSet.delete(url);
      urlSet.add(normalized);
    }
  }
}

function normalizeUrl(urlStr, canonicalHost) {
  const url = new URL(urlStr);

  // TODO option --force-https
  if (url.protocol === 'http:' && url.hostname !== 'localhost') {
    url.protocol = 'https:';
  }

  // TODO option --canonical-url
  url.host = canonicalHost;

  // TODO option --include-hash (but normalize # to '')
  url.hash = '';

  return url.toString();
}

function normalizeExternalUrl(urlStr) {
  const url = new URL(urlStr);

  url.hash = '';

  return url.toString();
}

async function getInitialState(filename: string) {
  try {
    // @ts-expect-error -- TypeScript is wrong here
    return JSON.parse(await fs.promises.readFile(filename));
  } catch {
    return null;
  }
}

const nextSaveState = {};

function saveState(filename, obj) {
  nextSaveState[filename] = obj;

  save(filename);
}

const isSaving = {};

function save(filename) {
  if (isSaving[filename] || nextSaveState[filename] == null) {
    return;
  }

  isSaving[filename] = true;

  const state = nextSaveState[filename];
  nextSaveState[filename] = null;

  fs.writeFile(filename, JSON.stringify(state, transformJson, 2)).then(() => {
    isSaving[filename] = false;
    save(filename);
  });
}

function isSameDomain(validDomains, rawUrlB) {
  const urlB = new URL(rawUrlB);

  // alias http to https
  if (urlB.protocol === 'http:') {
    urlB.protocol = 'https:';
  }

  for (const rawUrlA of validDomains) {
    try {
      const urlA = new URL(rawUrlA);

      // alias http to https
      if (urlA.protocol === 'http:') {
        urlA.protocol = 'https:';
      }

      if (urlA.origin === urlB.origin) {
        return true;
      }
    } catch (error) {
      console.error(error);
      console.error('INVALID URL', rawUrlB);

      return false;
    }
  }

  return false;
}

function transformJson(key, val) {
  if (val instanceof Set) {
    return [...val];
  }

  return val;
}

function slugify(text) {
  return text.toString().toLowerCase()
    .replaceAll(/[\s.]+/g, '-') // Replace spaces & dots with -
    .replaceAll(/[^\w-]+/g, '') // Remove all non-word chars
    .replaceAll(/--+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, ''); // Trim - from end of text
}

function addStyleContent(content) {
  const style = document.createElement('style');
  style.type = 'text/css';
  style.append(document.createTextNode(content));
  document.head.append(style);
}

async function runLighthouse(browser: Browser, url: string) {
  // Wait for Lighthouse to open url, then customize network conditions.
// Note: this will re-establish these conditions when LH reloads the page. Think that's ok....
  browser.on(BrowserContextEmittedEvents.TargetChanged, async (target: Target) => {
    const page = await target.page();

    const css = '* {color: red}';

    if (page && page.url() === url) {
      // Note: can't use page.addStyleTag due to github.com/GoogleChrome/puppeteer/issues/1955.
      // Do it ourselves.
      const client = await page.target().createCDPSession();
      await client.send('Runtime.evaluate', {
        expression: `(${addStyleContent.toString()})('${css}')`,
      });
    }
  });

  // Lighthouse will open URL. Puppeteer observes `targetchanged` and sets up network conditions.
  // Possible race condition.
  const { lhr } = await lighthouse(url, {
    port: Number((new URL(browser.wsEndpoint())).port),
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo', 'pwa'],
    output: 'json',
    logLevel: 'error',
  });

  // console.log('Report is done for', lhr.finalUrl);
  // // console.log(lhr);
  // console.log(`Lighthouse scores: ${Object.entries(lhr.categories).map(([key, result]) => {
  //   return `${key}: ${result.score}`;
  // }).join(', ')}`);

  return Object.fromEntries(Object.entries(lhr.categories).map(([key, result]) => {
    return [key, result.score];
  }));
}

await run();
