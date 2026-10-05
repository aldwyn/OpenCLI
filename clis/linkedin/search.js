import { randomBytes } from 'node:crypto';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
const LINKEDIN_DOMAIN = 'linkedin.com';
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const MIN_START = 0;
// ── Filter value mappings ──────────────────────────────────────────────
const EXPERIENCE_LEVELS = {
    internship: '1',
    entry: '2',
    'entry-level': '2',
    associate: '3',
    mid: '4',
    senior: '4',
    'mid-senior': '4',
    'mid-senior-level': '4',
    director: '5',
    executive: '6',
};
const JOB_TYPES = {
    'full-time': 'F',
    fulltime: 'F',
    full: 'F',
    'part-time': 'P',
    parttime: 'P',
    part: 'P',
    contract: 'C',
    temporary: 'T',
    temp: 'T',
    volunteer: 'V',
    internship: 'I',
    other: 'O',
};
const DATE_POSTED = {
    any: 'on',
    month: 'r2592000',
    'past-month': 'r2592000',
    week: 'r604800',
    'past-week': 'r604800',
    day: 'r86400',
    '24h': 'r86400',
    'past-24h': 'r86400',
};
const REMOTE_TYPES = {
    onsite: '1',
    'on-site': '1',
    hybrid: '3',
    remote: '2',
};
// ── Helpers ────────────────────────────────────────────────────────────
function parseCsvArg(value) {
    if (value === undefined || value === null || value === '')
        return [];
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}
function mapFilterValues(input, mapping, label) {
    const values = parseCsvArg(input);
    const resolved = values.map(value => {
        const key = value.toLowerCase();
        const mapped = mapping[key];
        if (!mapped)
            throw new ArgumentError(`Unsupported ${label}: ${value}`);
        return mapped;
    });
    return [...new Set(resolved)];
}
function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}
function parseIntegerArg(value, label, fallback, min, max = Infinity) {
    if (value === undefined || value === null || value === '')
        return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`${label} must be an integer, got ${JSON.stringify(value)}`);
    }
    if (parsed < min || parsed > max) {
        const range = Number.isFinite(max) ? `between ${min} and ${max}` : `at least ${min}`;
        throw new ArgumentError(`${label} must be ${range}, got ${parsed}`);
    }
    return parsed;
}
function decodeLinkedinRedirect(url) {
    if (!url)
        return '';
    try {
        const parsed = new URL(url);
        if (parsed.pathname === '/redir/redirect/') {
            return parsed.searchParams.get('url') || url;
        }
    }
    catch { }
    return url;
}
function generateReferralSearchId() {
    return randomBytes(16).toString('base64');
}
function buildJobSearchUrl(input) {
    const searchParams = new URLSearchParams();
    searchParams.set('keywords', input.keywords);
    if (input.location) {
        searchParams.set('location', input.location);
    }
    searchParams.set('origin', 'JOB_SEARCH_PAGE_JOB_FILTER');
    searchParams.set('referralSearchId', input.referralSearchId || generateReferralSearchId());
    const startNum = Number(input.start);
    if (Number.isFinite(startNum) && startNum > 0) {
        searchParams.set('start', String(startNum));
    }
    return `https://www.linkedin.com/jobs/search-results/?${searchParams.toString()}`;
}
function buildVoyagerSearchQuery(input) {
    const hasFilters = input.companyIds.length ||
        input.experienceLevels.length ||
        input.jobTypes.length ||
        input.datePostedValues.length ||
        input.remoteTypes.length;
    const parts = [
        'origin:' + (hasFilters ? 'JOB_SEARCH_PAGE_JOB_FILTER' : 'JOB_SEARCH_PAGE_OTHER_ENTRY'),
        'keywords:' + input.keywords,
    ];
    if (input.location) {
        parts.push('locationUnion:(seoLocation:(location:' + input.location + '))');
    }
    const filters = [];
    if (input.companyIds.length)
        filters.push('company:List(' + input.companyIds.join(',') + ')');
    if (input.experienceLevels.length)
        filters.push('experience:List(' + input.experienceLevels.join(',') + ')');
    if (input.jobTypes.length)
        filters.push('jobType:List(' + input.jobTypes.join(',') + ')');
    if (input.datePostedValues.length)
        filters.push('timePostedRange:List(' + input.datePostedValues.join(',') + ')');
    if (input.remoteTypes.length)
        filters.push('workplaceType:List(' + input.remoteTypes.join(',') + ')');
    if (filters.length)
        parts.push('selectedFilters:(' + filters.join(',') + ')');
    parts.push('spellCorrectionEnabled:true');
    return '(' + parts.join(',') + ')';
}
function buildVoyagerUrl(input, offset, count) {
    const params = new URLSearchParams({
        decorationId: 'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220',
        count: String(count),
        q: 'jobSearch',
    });
    const query = encodeURIComponent(buildVoyagerSearchQuery(input))
        .replace(/%3A/gi, ':')
        .replace(/%2C/gi, ',')
        .replace(/%28/gi, '(')
        .replace(/%29/gi, ')');
    return '/voyager/api/voyagerJobsDashJobCards?' + params.toString() + '&query=' + query + '&start=' + offset;
}
function looksLinkedInAuthWallText(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text)
        return false;
    return /\b(sign in|log in|join linkedin)\b/.test(text) ||
        /linkedin\.com\/(login|checkpoint|authwall)/i.test(text) ||
        /\b(captcha|verification required)\b/.test(text) ||
        /(请登录|登录领英|安全验证)/.test(text);
}
function buildLinkedInAuthProbeScript() {
    return `(() => {
      const text = [
        window.location.href || '',
        document.title || '',
        document.body ? (document.body.innerText || '').slice(0, 4000) : '',
      ].join('\\n');
      return ${looksLinkedInAuthWallText.toString()}(text);
    })()`;
}
async function assertLinkedInAuthenticated(page, context) {
    const authRequired = await page.evaluate(buildLinkedInAuthProbeScript());
    if (authRequired) {
        throw new AuthRequiredError(LINKEDIN_DOMAIN, `${context} requires an active signed-in LinkedIn browser session`);
    }
}
// ── Company ID resolution (requires DOM interaction) ──────────────────
async function resolveCompanyIds(page, input) {
    const rawValues = parseCsvArg(input);
    const ids = new Set();
    const names = [];
    for (const value of rawValues) {
        if (/^\d+$/.test(value))
            ids.add(value);
        else
            names.push(value);
    }
    if (!names.length)
        return [...ids];
    const resolved = await page.evaluate(`(async () => {
    const targets = ${JSON.stringify(names)};
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const normalize = (v) => (v || '').toLowerCase().replace(/\\s+/g, ' ').trim();

    // Open "All filters" panel to expose company filter inputs
    const allBtn = [...document.querySelectorAll('button')]
      .find(b => ((b.innerText || '').trim().replace(/\\s+/g, ' ')) === 'All filters');
    if (allBtn) { allBtn.click(); await sleep(300); }

    const getCompanyMap = () => {
      const map = {};
      for (const el of document.querySelectorAll('input[name="company-filter-value"]')) {
        const text = (el.parentElement?.innerText || el.closest('label')?.innerText || '')
          .replace(/\\s+/g, ' ').trim().replace(/\\s*Filter by.*$/i, '').trim();
        if (text) map[normalize(text)] = el.value;
      }
      return map;
    };

    const match = (map, name) => {
      const n = normalize(name);
      if (map[n]) return map[n];
      const k = Object.keys(map).find(e => e === n || e.includes(n) || n.includes(e));
      return k ? map[k] : null;
    };

    const results = {};
    let map = getCompanyMap();

    for (const name of targets) {
      let found = match(map, name);
      if (!found) {
        const inp = [...document.querySelectorAll('input')]
          .find(el => el.getAttribute('aria-label') === 'Add a company');
        if (inp) {
          inp.focus();
          inp.value = name;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
          await sleep(1200);
          map = getCompanyMap();
          found = match(map, name);
          inp.value = '';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(100);
        }
      }
      results[name] = found || null;
    }
    return results;
  })()`);
    const unresolved = [];
    for (const name of names) {
        const id = resolved?.[name];
        if (id)
            ids.add(id);
        else
            unresolved.push(name);
    }
    if (unresolved.length) {
        throw new ArgumentError(`Could not resolve LinkedIn company filter: ${unresolved.join(', ')}`);
    }
    return [...ids];
}
function formatHiringTeam(raw) {
    if (!raw) return null;
    const name = normalizeWhitespace(raw.name);
    const title = normalizeWhitespace(raw.title);
    const decodedUrl = decodeLinkedinRedirect(normalizeWhitespace(raw.profile_url));
    const profile_url = decodedUrl ? decodedUrl.split('?')[0].split('#')[0] : '';
    if (!name && !profile_url) return null;
    const team = {};
    team.name = name || null;
    team.title = title || null;
    team.profile_url = profile_url || null;
    team.toString = function() {
        if (this.name && this.title) return `${this.name} (${this.title})`;
        return this.name || this.profile_url || '';
    };
    return team;
}

function parseHiringTeamDom(root) {
    if (!root) return null;
    const clean = (s) => String(s || '').replace(/[\u00a0\u202f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const isHiringTeamTitle = (str) => /meet the hiring team/i.test(clean(str));

    let container = root.querySelector?.('[title*="Meet the hiring team" i], [aria-label*="Meet the hiring team" i], [role="alert"][title*="Meet the hiring team" i]');

    if (!container) {
        const candidates = Array.from(root.querySelectorAll?.('h1, h2, h3, h4, h5, div, section, p, span') || [])
            .filter(el => isHiringTeamTitle(el.getAttribute('title') || '') ||
                          isHiringTeamTitle(el.getAttribute('aria-label') || '') ||
                          (isHiringTeamTitle(el.innerText || el.textContent || '') && clean(el.innerText || el.textContent || '').length < 60));

        for (const cand of candidates) {
            const parent = cand.closest?.('[role="alert"], section, div.artdeco-card, div');
            if (parent && parent.querySelector?.('a[href*="/in/"]')) {
                container = parent;
                break;
            }
            if (cand.parentElement && cand.parentElement.querySelector?.('a[href*="/in/"]')) {
                container = cand.parentElement;
                break;
            }
        }
    }

    if (!container) {
        const allWithLink = Array.from(root.querySelectorAll?.('section, div, [role="alert"]') || [])
            .filter(el => isHiringTeamTitle(el.innerText || el.textContent || '') && el.querySelector?.('a[href*="/in/"]'));
        if (allWithLink.length > 0) {
            allWithLink.sort((a, b) => clean(a.innerText || a.textContent || '').length - clean(b.innerText || b.textContent || '').length);
            container = allWithLink[0];
        }
    }

    if (!container) return null;

    const profileLink = container.querySelector?.('a[href*="/in/"]');
    if (!profileLink) return null;

    let profileUrl = profileLink.href || profileLink.getAttribute('href') || '';
    if (profileUrl && !profileUrl.startsWith('http')) {
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : 'https://www.linkedin.com';
        try {
            profileUrl = new URL(profileUrl, origin).toString();
        } catch {
            profileUrl = 'https://www.linkedin.com' + (profileUrl.startsWith('/') ? '' : '/') + profileUrl;
        }
    }
    profileUrl = profileUrl.split('?')[0].split('#')[0];

    let name = clean(profileLink.innerText || profileLink.textContent || '');
    if (!name) {
        const nameEl = container.querySelector?.('strong, h3, h4, [class*="name"]');
        name = clean(nameEl?.innerText || nameEl?.textContent || '');
    }
    name = name.replace(/\s*·\s*(?:1st|2nd|3rd\+?|you)\s*$/i, '')
               .replace(/\s*\((?:he\/him|she\/her|they\/them)\)/i, '')
               .trim();

    const headlineEl = container.querySelector?.('[class*="headline"], [class*="subtitle"], [class*="occupation"], [class*="description"]');
    let title = headlineEl ? clean(headlineEl.innerText || headlineEl.textContent || '') : '';
    if (!title || isHiringTeamTitle(title) || title === name) {
        const textNodes = Array.from(container.querySelectorAll?.('div, p, span') || [])
            .map(el => clean(el.innerText || el.textContent || ''))
            .filter(t => t &&
                         !isHiringTeamTitle(t) &&
                         t !== name &&
                         !t.startsWith(name) &&
                         !/^(?:1st|2nd|3rd\+?|connect|message|follow|job poster|hiring team)$/i.test(t));
        title = textNodes[0] || '';
    }

    if (!name && !profileUrl) return null;

    const team = {};
    team.name = name || null;
    team.title = title || null;
    team.profile_url = profileUrl || null;
    return team;
}

// ── DOM extraction fallback (for semantic search & streaming cards) ───
async function extractJobCardsFromDom(page) {
    try {
        await page.wait({
            selector: '[componentkey^="job-card-component-ref-"], [data-occludable-job-id], [data-job-id], .job-card-container',
            timeout: 5,
        }).catch(() => {});
    } catch { }

    const rawJobs = await page.evaluate(`(() => {
        const selector = [
            '[componentkey^="job-card-component-ref-"]',
            '[data-occludable-job-id]',
            '[data-job-id]',
            'div.job-card-container',
            'li.jobs-search-results__list-item'
        ].join(', ');
        const cards = Array.from(document.querySelectorAll(selector));
        return cards.map(card => {
            const componentKey = card.getAttribute('componentkey') || '';
            const keyMatch = componentKey.match(/job-card-component-ref-(\\d+)/);
            const dataJobId = card.getAttribute('data-job-id') || card.getAttribute('data-occludable-job-id');
            const link = card.querySelector('a[href*="/jobs/view/"]');
            const linkMatch = (link?.getAttribute('href') || '').match(/\\/jobs\\/view\\/(\\d+)/);
            const jobId = keyMatch?.[1] || dataJobId || linkMatch?.[1] || '';
            const canonicalUrl = jobId ? ('https://www.linkedin.com/jobs/view/' + jobId) : (link?.href ? link.href.split('?')[0] : '');

            const paragraphs = Array.from(card.querySelectorAll('p')).map(p => (p.innerText || p.textContent || '').trim()).filter(Boolean);

            let title = '';
            const titleSpan = card.querySelector('p span.b4la5p') || 
                              card.querySelector('a.job-card-list__title') || 
                              card.querySelector('.job-card-list__title') ||
                              card.querySelector('p span');
            if (titleSpan) {
                title = (titleSpan.innerText || titleSpan.textContent || '').replace(/\\(Verified job\\)/gi, '').trim();
            }
            if (!title && paragraphs[0]) {
                title = paragraphs[0].replace(/\\(Verified job\\)/gi, '').trim();
            }
            title = title.split('\\n')[0].trim();

            const companyEl = card.querySelector('.job-card-container__primary-description') || 
                              card.querySelector('div[class*="b4llzp"] p') ||
                              card.querySelector('.job-card-container__company-name');
            const company = (companyEl?.innerText || companyEl?.textContent || paragraphs[1] || '').split('\\n')[0].trim();

            const locationEl = card.querySelector('.job-card-container__metadata-item') || 
                               card.querySelector('p[class*="b4llzp"]');
            const location = (locationEl?.innerText || locationEl?.textContent || paragraphs[2] || '').split('\\n')[0].trim();

            let listed = '';
            const timeEl = card.querySelector('time');
            if (timeEl) {
                listed = (timeEl.getAttribute('datetime') || timeEl.innerText || timeEl.textContent || '').trim();
            }
            if (!listed) {
                const listedSpan = Array.from(card.querySelectorAll('span, time, p')).find(el => {
                    const t = (el.innerText || el.textContent || '').trim();
                    return /posted\\s+\\d+/i.test(t) || /^\\d+\\s+(?:hours?|days?|weeks?|months?)\\s+ago$/i.test(t);
                });
                if (listedSpan) {
                    listed = (listedSpan.innerText || listedSpan.textContent || '').trim();
                } else {
                    const allText = (card.innerText || card.textContent || '').replace(/\\s+/g, ' ');
                    const match = allText.match(/(?:posted\\s+)?\\b(\\d+\\s+(?:hours?|days?|weeks?|months?)\\s+ago)\\b/i);
                    if (match) listed = match[0].trim();
                }
            }
            listed = listed.split('\\n')[0].trim();

            const allText = (card.innerText || card.textContent || '').replace(/\\s+/g, ' ');
            const salaryMatch = allText.match(/(\\$\\d[\\d,.]*\\s*k?\\b[^·]+|\\d+k\\s*[A-Z]{3}\\/yr\\s*-\\s*\\d+k\\s*[A-Z]{3}\\/yr)/i);
            const salary = salaryMatch ? salaryMatch[0].split('\\n')[0].trim() : '';

            return {
                title,
                company,
                location,
                listed,
                salary,
                url: canonicalUrl,
            };
        }).filter(j => j.title && j.url);
    })()`);

    if (!Array.isArray(rawJobs)) return [];

    const seen = new Set();
    const unique = [];
    for (const job of rawJobs) {
        if (!seen.has(job.url)) {
            seen.add(job.url);
            unique.push(job);
        }
    }
    return unique;
}

// ── DOM extraction with cursor / offset pagination ────────────────────
async function fetchJobCardsFromDom(page, input) {
    const PAGE_SIZE = 25;
    const allJobs = [];
    const seenUrls = new Set();
    let currentStart = input.start;
    const referralSearchId = input.referralSearchId || generateReferralSearchId();
    let pagesFetched = 0;
    const maxPages = Math.ceil(input.limit / PAGE_SIZE) + 2;

    while (allJobs.length < input.limit && pagesFetched < maxPages) {
        if (pagesFetched > 0) {
            const targetUrl = buildJobSearchUrl({
                keywords: input.keywords,
                location: input.location,
                start: currentStart,
                referralSearchId,
            });
            await page.goto(targetUrl);
            await assertLinkedInAuthenticated(page, 'LinkedIn search');
            await page.wait({ text: 'Jobs', timeout: 10 });
        }
        pagesFetched++;

        const pageJobs = await extractJobCardsFromDom(page);
        if (!pageJobs || pageJobs.length === 0) {
            break;
        }

        const needed = input.limit - allJobs.length;
        const currentBatch = [];
        for (const job of pageJobs) {
            if (!seenUrls.has(job.url)) {
                currentBatch.push(job);
                if (currentBatch.length >= needed) break;
            }
        }

        if (currentBatch.length === 0) {
            break;
        }

        // When details are requested, click the entry div from top to bottom of the current page before going to next page
        const processedBatch = input.includeDetails
            ? await enrichJobDetails(page, currentBatch)
            : currentBatch;

        let newJobsAdded = 0;
        for (const job of processedBatch) {
            if (!seenUrls.has(job.url)) {
                seenUrls.add(job.url);
                allJobs.push(job);
                newJobsAdded++;
                if (allJobs.length >= input.limit) {
                    break;
                }
            }
        }

        if (newJobsAdded === 0 || allJobs.length >= input.limit) {
            break;
        }

        if (pageJobs.length < PAGE_SIZE) {
            break;
        }

        currentStart += pageJobs.length;
    }

    return allJobs.slice(0, input.limit).map((item, index) => ({
        rank: input.start + index + 1,
        ...item,
    }));
}

// ── Voyager API fetch (runs inside page context for cookie access) ────
async function fetchJobCards(page, input) {
    const MAX_BATCH = 25;
    const allJobs = [];
    let offset = input.start;
    // Read JSESSIONID directly from the cookie store via CDP — zero page.evaluate round-trip
    const cookies = await page.getCookies?.({ url: 'https://www.linkedin.com' });
    const jsession = cookies?.find((c) => c.name === 'JSESSIONID')?.value;
    if (!jsession) {
        return await fetchJobCardsFromDom(page, input);
    }
    const csrf = jsession.replace(/^"|"$/g, '');
    while (allJobs.length < input.limit) {
        const remaining = input.limit - allJobs.length;
        const count = remaining > MAX_BATCH ? MAX_BATCH : remaining;
        const apiPath = buildVoyagerUrl(input, offset, count);
        let batch;
        try {
            batch = await page.evaluate(`(async () => {
          const res = await fetch(${JSON.stringify(apiPath)}, {
            credentials: 'include',
            headers: { 'csrf-token': ${JSON.stringify(csrf)}, 'x-restli-protocol-version': '2.0.0' },
          });
          if (res.status === 401 || res.status === 403) {
            const text = await res.text();
            return {
              authRequired: true,
              error: 'LinkedIn API authentication failed: HTTP ' + res.status + ' ' + text.slice(0, 200)
            };
          }
          if (!res.ok) {
            const text = await res.text();
            return { error: 'LinkedIn API error: HTTP ' + res.status + ' ' + text.slice(0, 200) };
          }
          return res.json();
        })()`);
        } catch {
            break;
        }
        if (!batch || batch.error) {
            if (batch?.authRequired) {
                throw new AuthRequiredError(LINKEDIN_DOMAIN, batch.error);
            }
            break;
        }
        const elements = Array.isArray(batch?.elements) ? batch.elements : [];
        if (elements.length === 0)
            break;
        for (const element of elements) {
            const card = element?.jobCardUnion?.jobPostingCard;
            if (!card)
                continue;
            // Extract job ID from URN fields
            const jobId = [card.jobPostingUrn, card.jobPosting?.entityUrn, card.entityUrn]
                .filter(Boolean)
                .map(s => String(s).match(/(\d+)/)?.[1])
                .find(Boolean) ?? '';
            // Extract listed date
            const listedItem = (card.footerItems || []).find((i) => i?.type === 'LISTED_DATE' && i?.timeAt);
            const listed = listedItem?.timeAt ? new Date(listedItem.timeAt).toISOString().slice(0, 10) : '';
            allJobs.push({
                title: card.jobPostingTitle || card.title?.text || '',
                company: card.primaryDescription?.text || '',
                location: card.secondaryDescription?.text || '',
                listed,
                salary: card.tertiaryDescription?.text || '',
                url: jobId ? 'https://www.linkedin.com/jobs/view/' + jobId : '',
            });
            if (allJobs.length >= input.limit)
                break;
        }
        if (elements.length < count)
            break;
        offset += elements.length;
    }

    if (allJobs.length === 0) {
        return await fetchJobCardsFromDom(page, input);
    }

    return allJobs.slice(0, input.limit).map((item, index) => ({
        rank: input.start + index + 1,
        ...item,
    }));
}
// ── Job detail enrichment (--details flag) ────────────────────────────
//
// Per-row failures should NOT abort the whole list (--details enriches N rows;
// partial failure is expected). But silent empty-string fields hide the failure
// from callers — previously `catch {}` and the `if (!job.url)` early-return
// both produced indistinguishable `description: '', apply_url: ''` payloads,
// so users could not tell "fetch failed" from "upstream had no description".
//
// To extract details efficiently without opening new tabs or navigating away,
// `enrichJobDetails` clicks each job card in the current search page DOM
// so LinkedIn loads the details into the right-side pane. If the card cannot
// be found on the current page or in-page loading fails to yield a description,
// it gracefully falls back to `page.goto(job.url)`.

async function clickJobCardInDom(page, job, index = 0) {
    const jobId = String(job.url || '').match(/\/jobs\/view\/(\d+)/)?.[1] || '';
    const clicked = await page.evaluate(`((targetJobId, targetUrl, targetTitle, targetIndex) => {
        const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const cleanTitle = norm(targetTitle);

        function clickElement(el) {
            if (!el) return false;
            try { el.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch {}
            try { el.focus?.(); } catch {}
            const mouseOpts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
            try {
                if (typeof PointerEvent !== 'undefined') {
                    el.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
                }
            } catch {}
            try { el.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch {}
            try {
                if (typeof PointerEvent !== 'undefined') {
                    el.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
                }
            } catch {}
            try { el.dispatchEvent(new MouseEvent('mouseup', mouseOpts)); } catch {}
            try { el.click(); } catch {}
            try { el.dispatchEvent(new MouseEvent('click', mouseOpts)); } catch {}
            return true;
        }

        // Helper to check if a card element matches the target job
        function matchesTarget(cardEl) {
            if (!cardEl) return false;
            if (targetJobId) {
                if (cardEl.getAttribute('componentkey')?.includes(targetJobId)) return true;
                if (cardEl.getAttribute('data-job-id') === targetJobId) return true;
                if (cardEl.getAttribute('data-occludable-job-id') === targetJobId) return true;
                if (cardEl.querySelector('a[href*="/jobs/view/' + targetJobId + '"]')) return true;
            }
            if (targetUrl) {
                const cleanUrl = targetUrl.split('?')[0];
                const links = Array.from(cardEl.querySelectorAll('a[href*="/jobs/view/"]'));
                if (links.some(a => (a.href || '').split('?')[0] === cleanUrl)) return true;
            }
            if (cleanTitle) {
                const text = norm(cardEl.textContent || '');
                if (text && text.includes(cleanTitle)) return true;
            }
            return false;
        }

        // 1. Gather all job card containers present in the DOM (in document order: top to bottom)
        const standardCardSelector = [
            '[componentkey^="job-card-component-ref-"]',
            '[data-occludable-job-id]',
            '[data-job-id]',
            'div.job-card-container',
            'li.jobs-search-results__list-item',
            '.jobs-search-results-list ul > li',
            'ul.jobs-search__results-list > li'
        ].join(', ');

        let cards = Array.from(document.querySelectorAll(standardCardSelector));

        // If no standard card classes are found, derive cards from all job view links in the list
        if (cards.length === 0) {
            const allJobLinks = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
            const cardSet = new Set();
            for (const link of allJobLinks) {
                // Ascend to find the list-item container for this link
                let cur = link.parentElement;
                let candidate = null;
                while (cur && cur !== document.body && !cur.matches('#workspace, main, section')) {
                    const parent = cur.parentElement;
                    if (parent) {
                        const siblingJobCount = Array.from(parent.children).filter(child => child.querySelector('a[href*="/jobs/view/"]')).length;
                        if (siblingJobCount > 1) {
                            candidate = cur;
                            break;
                        }
                    }
                    cur = cur.parentElement;
                }
                const found = candidate || link.closest('li') || link.parentElement;
                if (found && !cardSet.has(found)) {
                    cardSet.add(found);
                    cards.push(found);
                }
            }
        }

        // 2. Locate the specific card: match by ID/URL/title first, then fallback to top-to-bottom index
        let card = cards.find(matchesTarget);

        if (!card && typeof targetIndex === 'number' && targetIndex >= 0 && targetIndex < cards.length) {
            card = cards[targetIndex];
        }

        // 3. Fallback direct query if not matched in cards list
        if (!card && targetJobId) {
            const el = document.querySelector(
                '[componentkey*="' + targetJobId + '"], ' +
                '[data-job-id="' + targetJobId + '"], ' +
                '[data-occludable-job-id="' + targetJobId + '"], ' +
                'a[href*="/jobs/view/' + targetJobId + '"]'
            );
            if (el) {
                card = el.closest('[componentkey^="job-card-component-ref-"], [data-occludable-job-id], [data-job-id], .job-card-container, li.jobs-search-results__list-item, li') || el.parentElement;
            }
        }

        if (!card && targetUrl) {
            const cleanUrl = targetUrl.split('?')[0];
            const links = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
            const link = links.find(a => (a.href || '').split('?')[0] === cleanUrl);
            if (link) {
                card = link.closest('[componentkey^="job-card-component-ref-"], [data-occludable-job-id], [data-job-id], .job-card-container, li.jobs-search-results__list-item, li') || link.parentElement;
            }
        }

        if (!card && cleanTitle) {
            const allEls = Array.from(document.querySelectorAll('div, li, article')).filter(el => {
                const t = norm(el.textContent || '');
                return t && t.includes(cleanTitle) && el.querySelector('a[href*="/jobs/view/"]');
            });
            if (allEls.length > 0) {
                card = allEls[0];
            }
        }

        if (!card) return false;

        // Ensure card itself is not an anchor tag
        while (card && (card.tagName.toLowerCase() === 'a' || card.closest('a'))) {
            card = card.parentElement;
        }
        if (!card) return false;

        // 4. Find the non-hyperlink entry div at that level to click:
        // Exclude all anchors and buttons so we do not open new tabs or trigger actions (like Save)
        const nonLinkDivs = Array.from(card.querySelectorAll('div')).filter(d => {
            return !d.closest('a') && !d.closest('button, [role="button"]');
        });

        let clickable = null;
        if (nonLinkDivs.length > 0) {
            // Find the deepest inner container div that has content (the entry card body / content wrapper)
            const contentDivs = nonLinkDivs.filter(d => {
                const text = (d.textContent || '').trim();
                return text.length > 0 && d.children.length > 0;
            });
            clickable = contentDivs.length > 0 ? contentDivs[contentDivs.length - 1] : nonLinkDivs[nonLinkDivs.length - 1];
        }

        if (!clickable && !card.closest('a') && !card.closest('button, [role="button"]') && card.tagName.toLowerCase() !== 'a') {
            clickable = card;
        }

        if (!clickable) return false;

        return clickElement(clickable);
    })(${JSON.stringify(jobId)}, ${JSON.stringify(job.url || '')}, ${JSON.stringify(job.title || '')}, ${Number(index)})`);

    return Boolean(clicked);
}

async function extractJobDetailsFromDom(page) {
    // Expand "...more" / "Show more" button if present to reveal full "About the job" details
    await page.evaluate(`(() => {
        const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim().toLowerCase();

        function clickBtn(btn) {
            if (!btn) return false;
            try { btn.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch {}
            try { btn.focus?.(); } catch {}
            const mouseOpts = { bubbles: true, cancelable: true, view: window, buttons: 1, detail: 1 };
            try {
                if (typeof PointerEvent !== 'undefined') {
                    btn.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
                }
            } catch {}
            try { btn.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch {}
            try {
                if (typeof PointerEvent !== 'undefined') {
                    btn.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
                }
            } catch {}
            try { btn.dispatchEvent(new MouseEvent('mouseup', mouseOpts)); } catch {}
            try {
                btn.click();
            } catch {
                try { btn.dispatchEvent(new MouseEvent('click', mouseOpts)); } catch {}
            }
            return true;
        }

        function isTargetMoreButton(el) {
            if (!el) return false;
            // Exclude header, navigation, and filter bar buttons
            if (el.closest('header, nav, [role="navigation"], [class*="filter"], [aria-label*="filter"]')) return false;

            const testId = el.getAttribute('data-testid') || '';
            if (testId === 'expandable-text-button' || testId.includes('expandable-text')) return true;

            const t = norm(el.textContent || '');
            const aria = norm(el.getAttribute('aria-label') || '');

            // Explicitly reject filters and "learn more" buttons
            if (/filter|learn\\s*more/i.test(t) || /filter|learn\\s*more/i.test(aria)) return false;

            // Match "...more", "…more", "... more", "… more", "show more", "see more", or "...see more"
            const pattern = /^(?:(?:\\.{3}|…)\\s*)?(?:show\\s+more|see\\s+more|more)(?:\\s+.*)?$/i;
            return pattern.test(t) || pattern.test(aria);
        }

        // 1. Highest priority: Target standard LinkedIn expandable text buttons directly
        const testIdButtons = Array.from(document.querySelectorAll(
            'button[data-testid="expandable-text-button"], [data-testid="expandable-text-button"], button[data-testid*="expandable-text"], [data-testid*="expandable-text"], button.inline-show-more-text__button, button.show-more-less-html__button'
        )).filter(b => !b.closest('header, nav, [role="navigation"], [class*="filter"], [aria-label*="filter"]'));

        for (const btn of testIdButtons) {
            if (clickBtn(btn)) return true;
        }

        // 2. Look inside the resolved details pane or "About the job" container
        let detailsPane = document.querySelector(
            '.jobs-search__job-details--container, .jobs-search-results-list__details, .jobs-details, [class*="job-details--container"], [class*="jobs-details"], [class*="job-view-layout"], #job-details, .jobs-description'
        );

        if (!detailsPane) {
            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, span, strong, div, p'));
            const aboutHeading = headings.find(el => {
                const t = norm(el.textContent || '');
                return t === 'about the job' || t.startsWith('about the job');
            });
            if (aboutHeading) {
                detailsPane = aboutHeading.closest('section, article, div[class*="detail"], div[class*="description"]') || 
                              aboutHeading.parentElement?.parentElement?.parentElement ||
                              aboutHeading.parentElement?.parentElement || 
                              aboutHeading.parentElement;
            }
        }

        if (detailsPane) {
            const buttons = Array.from(detailsPane.querySelectorAll('button, a[role="button"], span[role="button"], [class*="show-more"], [class*="see-more"]'));
            const moreBtn = buttons.find(isTargetMoreButton);
            if (moreBtn && clickBtn(moreBtn)) return true;
        }

        // 3. Fallback: search document for explicit "...more" or "…more" button near the job description
        const allCandidates = Array.from(document.querySelectorAll('button, a[role="button"], span[role="button"], [class*="show-more"], [class*="see-more"]'));
        const directMoreBtn = allCandidates.find(el => {
            const t = norm(el.textContent || '');
            const aria = norm(el.getAttribute('aria-label') || '');
            const isEllipsisMore = /^(?:\\.{3}|…)\\s*(?:more|see\\s+more|show\\s+more)$/i.test(t) || 
                                   /^(?:\\.{3}|…)\\s*(?:more|see\\s+more|show\\s+more)$/i.test(aria);
            if (!isEllipsisMore) return false;
            if (el.closest('header, nav, [role="navigation"], [class*="filter"], [aria-label*="filter"]')) return false;
            return true;
        });

        if (directMoreBtn) {
            clickBtn(directMoreBtn);
        }
    })()`);

    await page.wait(0.5);

    const detail = await page.evaluate(`(() => {
        const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
        let rightPane = document.querySelector(
            '.jobs-search__job-details--container, .jobs-search-results-list__details, .jobs-details, [class*="job-details--container"], [class*="jobs-details"], [class*="job-view-layout"], #job-details, .jobs-description'
        );

        if (!rightPane) {
            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, span, strong, div, p'));
            const aboutHeading = headings.find(el => {
                const t = norm(el.textContent || '').toLowerCase();
                return t === 'about the job' || t.startsWith('about the job');
            });
            if (aboutHeading) {
                rightPane = aboutHeading.closest('section, article, div[class*="detail"], div[class*="description"]') || 
                            aboutHeading.parentElement?.parentElement?.parentElement ||
                            aboutHeading.parentElement?.parentElement || 
                            aboutHeading.parentElement;
            }
        }

        const scope = rightPane
            ? [rightPane, ...rightPane.querySelectorAll('div, section, article, main')]
            : Array.from(document.querySelectorAll('div, section, article, main'));

        // 1. Search by heading "About the job" across any tag
        const candidates = scope
          .map(el => ({
            heading: norm(el.querySelector('h1,h2,h3,h4,h5,h6, [class*="heading"], span, p, div, strong')?.textContent || ''),
            text: norm(el.innerText || el.textContent || ''),
          }))
          .filter(c => c.text && c.heading.toLowerCase() === 'about the job' && c.text.length > 'About the job'.length)
          .sort((a, b) => a.text.length - b.text.length);

        let description = candidates[0]?.text.replace(/^About the job\\s*/i, '') || '';

        // 2. If no candidate found, search for any element containing "about the job" heading text
        if (!description) {
            const headingEl = Array.from((rightPane || document).querySelectorAll('h1,h2,h3,h4,h5,h6,span,p,div,strong,b'))
                .find(el => {
                    const t = norm(el.textContent || '').toLowerCase();
                    return t === 'about the job' || t.startsWith('about the job');
                });
            if (headingEl) {
                const parent = headingEl.closest('section, article, div') || headingEl.parentElement;
                if (parent) {
                    description = norm(parent.innerText || parent.textContent || '').replace(/^About the job\\s*/i, '');
                }
            }
        }

        // 3. Fallback to standard description container selectors
        if (!description) {
            const descEl = (rightPane || document).querySelector?.('#job-details, .jobs-description__content, .jobs-box__html-content, [class*="jobs-description"]');
            if (descEl) {
                description = norm(descEl.innerText || descEl.textContent || '');
            }
        }

        description = description
            .replace(/Meet the hiring team[\\s\\S]*$/i, '')
            .replace(/\\s*(?:(?:\\.{3}|…)\\s*)?(?:show\\s+more|see\\s+more|show\\s+less|see\\s+less|more|less)\\s*$/i, '')
            .replace(/\\s*(?:\\.{3}|…)\\s*$/i, '')
            .trim();

        const applyContainer = rightPane || document;
        const applyLink = [...(applyContainer?.querySelectorAll?.('a[href]') || [])]
          .map(a => ({ href: a.href || '', text: norm(a.textContent || ''), aria: norm(a.getAttribute('aria-label') || '') }))
          .find(a => /apply/i.test(a.text) || /apply/i.test(a.aria));

        ${parseHiringTeamDom.toString()}
        const hiringTeam = parseHiringTeamDom(rightPane) || parseHiringTeamDom(document);

        return { description, applyUrl: applyLink?.href || '', hiringTeam };
    })()`);

    return detail;
}

async function enrichJobDetails(page, jobs) {
    const enriched = [];
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        console.error(`[opencli:linkedin] Fetching details ${i + 1}/${jobs.length}: ${job.title}`);
        if (!job.url) {
            const reason = 'no url';
            console.error(`[opencli:linkedin] Skipping detail for "${job.title}": ${reason}`);
            enriched.push({ ...job, description: null, apply_url: null, hiring_team: null, detail_error: reason });
            continue;
        }
        try {
            let detail = null;
            let clicked = false;
            try {
                clicked = await clickJobCardInDom(page, job, i);
            } catch {
                clicked = false;
            }

            if (clicked) {
                // Poll right pane up to 3s for details to render in-place
                for (let attempt = 0; attempt < 6; attempt++) {
                    await page.wait(0.5);
                    detail = await extractJobDetailsFromDom(page);
                    if (detail?.description) break;
                }
            }

            // Fallback: If card was not in current DOM or in-place loading did not yield a description
            if (!detail || !detail.description) {
                await page.goto(job.url);
                await assertLinkedInAuthenticated(page, 'LinkedIn job detail');
                await page.wait({ text: 'About the job', timeout: 8 }).catch(() => {});
                detail = await extractJobDetailsFromDom(page);
            }

            const description = normalizeWhitespace(detail?.description);
            const apply_url = decodeLinkedinRedirect(String(detail?.applyUrl ?? ''));
            const hiring_team = formatHiringTeam(detail?.hiringTeam);

            const detail_error = description ? null : 'missing description';
            enriched.push({
                ...job,
                description: description || null,
                apply_url: apply_url || null,
                hiring_team,
                detail_error,
            });
        }
        catch (err) {
            if (err instanceof AuthRequiredError)
                throw err;
            const reason = `fetch failed: ${err?.message || err}`;
            console.error(`[opencli:linkedin] Detail fetch failed for ${job.url}: ${reason}`);
            enriched.push({ ...job, description: null, apply_url: null, hiring_team: null, detail_error: reason });
        }
    }
    return enriched;
}
// ── CLI registration ──────────────────────────────────────────────────
cli({
    site: 'linkedin',
    name: 'search',
    access: 'read',
    description: 'Search LinkedIn jobs',
    domain: 'www.linkedin.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'query', type: 'string', required: true, positional: true, help: 'Job search keywords' },
        { name: 'location', type: 'string', required: false, help: 'Location text such as San Francisco Bay Area' },
        { name: 'limit', type: 'int', default: 10, help: 'Number of jobs to return (max 100)' },
        { name: 'start', type: 'int', default: 0, help: 'Result offset for pagination' },
        { name: 'details', type: 'bool', default: false, help: 'Include full job description, apply URL, and hiring team (slower)' },
        { name: 'company', type: 'string', required: false, help: 'Comma-separated company names or LinkedIn company IDs' },
        { name: 'experience-level', type: 'string', required: false, help: 'Comma-separated: internship, entry, associate, mid-senior, director, executive' },
        { name: 'job-type', type: 'string', required: false, help: 'Comma-separated: full-time, part-time, contract, temporary, volunteer, internship, other' },
        { name: 'date-posted', type: 'string', required: false, help: 'One of: any, month, week, 24h' },
        { name: 'remote', type: 'string', required: false, help: 'Comma-separated: on-site, hybrid, remote' },
    ],
    columns: ['rank', 'title', 'company', 'location', 'listed', 'salary', 'url'],
    func: async (page, kwargs) => {
        const limit = parseIntegerArg(kwargs.limit, '--limit', 10, MIN_LIMIT, MAX_LIMIT);
        const start = parseIntegerArg(kwargs.start, '--start', 0, MIN_START);
        const includeDetails = Boolean(kwargs.details);
        const location = (kwargs.location ?? '').trim();
        const keywords = String(kwargs.query ?? '').trim();
        if (!keywords)
            throw new ArgumentError('query is required');
        const referralSearchId = generateReferralSearchId();
        const searchUrl = buildJobSearchUrl({ keywords, location, start, referralSearchId });
        await page.goto(searchUrl);
        await assertLinkedInAuthenticated(page, 'LinkedIn search');
        await page.wait({ text: 'Jobs', timeout: 10 });
        const companyIds = await resolveCompanyIds(page, kwargs.company);
        const input = {
            keywords,
            location,
            limit,
            start,
            includeDetails,
            referralSearchId,
            companyIds,
            experienceLevels: mapFilterValues(kwargs['experience-level'], EXPERIENCE_LEVELS, 'experience_level'),
            jobTypes: mapFilterValues(kwargs['job-type'], JOB_TYPES, 'job_type'),
            datePostedValues: mapFilterValues(kwargs['date-posted'], DATE_POSTED, 'date_posted'),
            remoteTypes: mapFilterValues(kwargs.remote, REMOTE_TYPES, 'remote'),
        };
        const data = await fetchJobCards(page, input);
        if (!includeDetails)
            return data;
        if (data.length > 0 && ('description' in data[0] || 'hiring_team' in data[0])) {
            return data;
        }
        return enrichJobDetails(page, data);
    },
});

export const __test__ = {
    parseCsvArg,
    parseIntegerArg,
    mapFilterValues,
    decodeLinkedinRedirect,
    looksLinkedInAuthWallText,
    assertLinkedInAuthenticated,
    enrichJobDetails,
    generateReferralSearchId,
    buildJobSearchUrl,
    extractJobCardsFromDom,
    fetchJobCardsFromDom,
    fetchJobCards,
    formatHiringTeam,
    parseHiringTeamDom,
    clickJobCardInDom,
    extractJobDetailsFromDom,
    EXPERIENCE_LEVELS,
    JOB_TYPES,
    DATE_POSTED,
    REMOTE_TYPES,
};
