#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const lighthouse = require('lighthouse');
const puppeteer = require('puppeteer');
const meow = require('meow');

// TODO: respect noindex/nofollow if flag is set
// TODO: use sitemap.xml
// TODO: collect robots.txt
// TODO: handle rel=alternate
// TODO: handle rel=canonical
// TODO: disable auto-redirect & log redirection chains - https://github.com/puppeteer/puppeteer/issues/1132
// TODO: if a page has the same MD5 as another, tag them as "potential canonicals" & warn if they're not tagged as canonicals of one-another
// TODO: run lighthouse mobile + desktop
// TODO: check if #anchor exists?
// TODO: remove anchor when requesting a page?
// TODO: normalize trailing /

function md4(text) {
  return crypto.createHash('md4').update(text).digest('hex');
}

const cliName = path.relative(process.cwd(), process.argv[1]);

const cli = meow(`
	Usage
	  $ ${cliName} <url>

	Options
	  --domain-alias <url>  Add an extra domain that the scraper can consider as being the same domain as the base url.
	  --collect-meta        Collect SEO metadata (title, description, etc) of crawled webpages.
	  --delay <delay>       Pause time between two page fetches in ms (default to 500ms).
	  --lighthouse          Run lighthouse on crawled pages.

	Examples
	  $ ${cliName} https://wellmade.be --domain-alias https://www.wellmade.be
`, {
  flags: {
    'domain-alias': {
      type: 'string',
    },
    'collect-meta': {
      type: 'boolean',
      default: false,
    },
    'delay': {
      type: 'string',
      inferType: true,
      default: '500',
    },
    'lighthouse': {
      type: 'boolean',
      default: false,
    },
  }
});

let browser;
(async () => {
  const initialUrl = cli.input[0];
  if (!initialUrl) {
    cli.showHelp();
    return;
  }

  const canonicalHost = (new URL(initialUrl)).host;
  const stateFile = `${process.cwd()}/${slugify(canonicalHost)}.json`;
  const seoFile = `${process.cwd()}/${slugify(canonicalHost)}.seo.json`;

  const delay = Number(cli.flags.delay);
  const collectSeo = cli.flags.collectMeta || false;
  const collectLighthouse = cli.flags.lighthouse || false;
  const validDomains = !cli.flags.domainAlias
    ? []
    : Array.isArray(cli.flags.domainAlias)
    ? cli.flags.domainAlias
    : [cli.flags.domainAlias];

  validDomains.push(initialUrl);

  console.info(`SAVING STATE TO ${stateFile}`);
  if (collectSeo) {
    console.info(`SAVING SEO TO ${seoFile}`);
  }

  const initialState = await getInitialState(stateFile);
  const seoState = collectSeo ? await getInitialState(seoFile) || {} : null;

  browser = await puppeteer.launch();
  const page = await browser.newPage();

  const visitedUrls = new Set(initialState && initialState.visitedUrls || []);
  const pendingUrls = new Set(initialState && initialState.pendingUrls || [initialUrl]);
  const externalUrls = new Set(initialState && initialState.externalUrls || []);
  const unreachableUrls = new Set(initialState && initialState.unreachableUrls || []);

  // retry unreachable urls
  for (const url of unreachableUrls) {
    unreachableUrls.delete(url);
    pendingUrls.add(url);
  }

  if (collectSeo) {
    let moved = 0;

    for (const url of visitedUrls) {
      if (!seoState[url]) {
        visitedUrls.delete(url);
        pendingUrls.add(url);
        moved++;
      }
    }

    if (moved > 0) {
      console.info(`Re-crawling ${moved} urls as their SEO data was not crawled`);
    }
  }

  // reduce requests
  // await page.setRequestInterception(true);

  normalizeUrlSet(visitedUrls, canonicalHost);
  normalizeUrlSet(pendingUrls, canonicalHost);
  // we don't normalize external urls as we can't assume anything about other websites

  while (pendingUrls.size > 0) {
    await sleep(delay);

    const visitingUrl = pendingUrls.values().next().value;
    const pageMeta = {};

    console.log('[VISITING]', visitingUrl);

    const logRequests = request => {
      /*
       document, stylesheet, image, media, font, script, texttrack, xhr, fetch, eventsource, websocket, manifest, other
       */

      if (collectSeo) {
        const url = request.url();
        const type = request.resourceType();

        if (['image', 'stylesheet', 'font', 'media', 'script'].includes(type)) {
          pageMeta[type] = pageMeta[type] || [];

          pageMeta[type].push(url);
        } else {
          console.log('Untracked request', type, url);
        }
      }
    };

    try {
      page.on('request', logRequests);

      try {
        // if we collect SEO: we wait for page to be fully loaded as we collect the list of referenced resources
        const response = await page.goto(visitingUrl, collectSeo ? { waitUntil: 'networkidle2' } : undefined);
        if (!response.ok()) {
          console.error('[COULD NOT NAVIGATE]', visitingUrl, `(${response.status()})`);
          unreachableUrls.add(visitingUrl);
          pendingUrls.delete(visitingUrl);
          continue;
        }
      } catch (e) {
        console.error('[COULD NOT NAVIGATE]', visitingUrl, `(${e.message})`);
        unreachableUrls.add(visitingUrl);
        pendingUrls.delete(visitingUrl);
        continue;
      }

      const { anchors, meta: seoMeta } = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a')).map(anchor => anchor.href);

        const metaTags = document.querySelectorAll('meta[name="robots"], meta[name="description"], meta[name="keywords"], meta[property^="og:"], meta[name^="twitter:"]');
        const metaMapping = {};
        for (const metaTag of metaTags) {
          const name = metaTag.getAttribute('name') || metaTag.getAttribute('property');
          metaMapping[name] = metaTag.content;
        }

        const meta = {
          title: document.title,
          ...metaMapping,
        };

        return {
          anchors,
          meta,
        };
      });

      if (collectSeo) {
        const pageHash = md4(await page.content());
        let lighthouseScore;
        if (collectLighthouse) {
          lighthouseScore = await runLighthouse(browser, visitingUrl);
        }

        seoState[visitingUrl] = Object.assign(pageMeta, seoMeta, {
          anchors,
          lighthouse: lighthouseScore,
          hash: pageHash,
        });

        // seoState[visitingUrl].microdata = await evaluateMicrodata(page);
        saveState(seoFile, seoState);
      }

      for (const url of anchors) {

        if (!url) {
          continue;
        }

        const normalized = normalizeUrl(url, canonicalHost);

        if (!isSameDomain(validDomains, url)) {
          externalUrls.add(url);
        } else if (!visitedUrls.has(normalized) && !pendingUrls.has(normalized)) {
          pendingUrls.add(normalized);
          console.log('[DISCOVERED]', normalized);
        }
      }

      visitedUrls.add(visitingUrl);
      pendingUrls.delete(visitingUrl);

      saveState(stateFile, { visitedUrls, pendingUrls, externalUrls, unreachableUrls });
    } finally {
      page.off('request', logRequests);
    }
  }
})().finally(() => {
  return browser && browser.close();
});

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
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
  }

  // TODO option --canonical-url
  url.host = canonicalHost;

  // TODO option --include-hash
  // url.hash === '' because if url ends with #, hash is '' instead of '#'
  // if (url.hash === '' || url.hash === '#' || url.hash === '#null') {
  url.md4 = '';
  // }

  return url.toString();
}

async function getInitialState(path) {
  try {
    return JSON.parse(await fs.promises.readFile(path, 'utf-8'));
  } catch (e) {
    return null;
  }
}

let nextSaveState = {};
function saveState(path, obj) {
  nextSaveState[path] = obj;

  save(path);
}

let isSaving = {};
function save(path) {
  if (isSaving[path] || nextSaveState[path] == null) {
    return;
  }

  isSaving[path] = true;

  const state = nextSaveState[path];
  nextSaveState[path] = null;

  fs.promises.writeFile(path, JSON.stringify(state, transformJson, 2)).then(() => {
    isSaving[path] = false;
    save(path);
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
    } catch (e) {
      console.log(e);
      console.log('INVALID URL', rawUrlB);
      return false;
    }
  }

  return false;
}

function transformJson(key, val) {
  if (val instanceof Set) {
    return Array.from(val);
  }

  return val;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toString().toLowerCase()
    .replace(/[\s.]+/g, '-')           // Replace spaces & dots with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/--+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
}

function evaluateMicrodata(page) {
  return page.evaluate(() => {
    function deleteAll(set, deletableItems) {
      for (const item of deletableItems) {
        set.delete(item);
      }
    }

    function parseMicrodata(document) {
      return [
        ...parseMicrodataDomTree(document),
        ...parseMicrodataJsonLd(document),
      ];
    }

    function parseMicrodataJsonLd(document) {
      const output = [];

      for (const scriptTag of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          output.push(JSON.parse(scriptTag.textContent));
        } catch (e) {
          output.push(scriptTag.textContent);
        }
      }

      return output;
    }

    function querySelectorInclusive(root, query) {
      const out = [];

      if (root.matches(query)) {
        out.push(root);
      }

      out.push(...root.querySelectorAll(query));

      return out;
    }

    function parseMicrodataDomTree(root) {
      if (root === document) {
        root = document.documentElement;
      }

      const itemScopes = new Set(querySelectorInclusive(root, ':scope [itemscope][itemtype], :scope[itemscope][itemtype]'));

      // delete nested itemscopes, only get first level!
      deleteAll(itemScopes, root.querySelectorAll(':scope [itemscope] [itemscope]'));

      return Array.from(itemScopes).map(itemScopeElem => {
        const itemType = itemScopeElem.getAttribute('itemtype');

        const output = {
          '@type': itemType,
        };

        const itemProps = new Set(itemScopeElem.querySelectorAll(':scope [itemprop]'));

        // delete nested itemprop, they belong to other scopes
        deleteAll(itemProps, itemScopeElem.querySelectorAll(':scope [itemscope] [itemprop]'));

        for (const itemPropElem of itemProps) {
          const propName = itemPropElem.getAttribute('itemprop');
          let value;

          if (itemPropElem.hasAttribute('itemscope')) {
            value = parseMicrodataDomTree(itemPropElem);
            if (value.length < 2) {
              value = value[0];
            }
          } else {
            switch (itemPropElem.nodeName.toLowerCase()) {
              case 'audio':
              case 'embed':
              case 'iframe':
              case 'img':
              case 'source':
              case 'track':
              case 'video':
                value = itemPropElem.getAttribute('src');
                break;
              case 'a':
              case 'area':
              case 'link':
                value = itemPropElem.getAttribute('href');
                break;
              case 'object':
                value = itemPropElem.getAttribute('data');
                break;
              default:
                value = itemPropElem.innerHTML.trim();
                break;
            }
          }

          if (!value) {
            continue;
          }

          if (output[propName] === void 0) {
            output[propName] = value;
          } else {
            if (!Array.isArray(props[propName])) {
              output[propName] = [props[propName]];
            }

            output[propName].push(value);
          }
        }

        return output;
      });
    }

    return parseMicrodata(document);
  });
}

async function runLighthouse(browser, url) {
  // Wait for Lighthouse to open url, then customize network conditions.
// Note: this will re-establish these conditions when LH reloads the page. Think that's ok....
  browser.on('targetchanged', async target => {
    const page = await target.page();

    function addStyleContent(content) {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      document.head.appendChild(style);
    }

    const css = '* {color: red}';

    if (page && page.url() === url) {
      // Note: can't use page.addStyleTag due to github.com/GoogleChrome/puppeteer/issues/1955.
      // Do it ourselves.
      const client = await page.target().createCDPSession();
      await client.send('Runtime.evaluate', {
        expression: `(${addStyleContent.toString()})('${css}')`
      });
    }
  });

// Lighthouse will open URL. Puppeteer observes `targetchanged` and sets up network conditions.
// Possible race condition.
  const {lhr} = await lighthouse(url, {
    port: (new URL(browser.wsEndpoint())).port,
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
