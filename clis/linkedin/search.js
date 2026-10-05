import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';

const LINKEDIN_DOMAIN = 'linkedin.com';
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const MIN_START = 0;

// ── Helpers ────────────────────────────────────────────────────────────

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
    const parts = [
        'origin:JOB_SEARCH_PAGE_OTHER_ENTRY',
        'keywords:' + input.keywords,
        'spellCorrectionEnabled:true',
    ];
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

// ── Output Streaming (append to file/stdout immediately) ───────────────

function resolveOutputFormat(kwargs) {
    if (kwargs?.format && typeof kwargs.format === 'string') {
        return kwargs.format.toLowerCase();
    }
    for (let i = 0; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if ((arg === '-f' || arg === '--format') && process.argv[i + 1]) {
            return process.argv[i + 1].toLowerCase();
        }
        if (arg.startsWith('--format=')) {
            return arg.slice('--format='.length).toLowerCase();
        }
        if (arg.startsWith('-f=')) {
            return arg.slice('-f='.length).toLowerCase();
        }
    }
    const outputFile = kwargs?.output || kwargs?.file;
    if (outputFile) {
        const ext = path.extname(outputFile).toLowerCase();
        if (ext === '.yml' || ext === '.yaml') return 'yaml';
        if (ext === '.json') return 'json';
        if (ext === '.jsonl') return 'jsonl';
        if (ext === '.csv') return 'csv';
        if (ext === '.md') return 'markdown';
    }
    if (!process.stdout.isTTY) {
        return 'yaml';
    }
    return 'table';
}

function resolveOutputFile(kwargs) {
    if (kwargs?.output) return String(kwargs.output);
    if (kwargs?.file) return String(kwargs.file);
    for (let i = 0; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if ((arg === '-o' || arg === '--output' || arg === '--file') && process.argv[i + 1]) {
            return process.argv[i + 1];
        }
        if (arg.startsWith('--output=')) return arg.slice('--output='.length);
        if (arg.startsWith('--file=')) return arg.slice('--file='.length);
        if (arg.startsWith('-o=')) return arg.slice('-o='.length);
    }
    return null;
}

class StreamWriter {
    constructor(format, outputFilePath) {
        this.format = format;
        this.outputFilePath = outputFilePath;
        this.writeToStdout = format !== 'table';
        this.count = 0;
        this.closed = false;

        this.sigintHandler = () => {
            this.close();
            process.exit(130);
        };
        process.once('SIGINT', this.sigintHandler);
        process.once('SIGTERM', this.sigintHandler);

        if (this.outputFilePath) {
            try {
                const dir = path.dirname(this.outputFilePath);
                if (dir && !fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            } catch {}
        }
    }

    writeRow(row) {
        let text = '';
        if (this.format === 'yaml' || this.format === 'yml') {
            text = yaml.dump([row], { sortKeys: false, lineWidth: 120, noRefs: true });
        } else if (this.format === 'json') {
            const prefix = this.count === 0 ? '[\n' : ',\n';
            const indented = JSON.stringify(row, null, 2).replace(/^/gm, '  ');
            text = prefix + indented;
        } else if (this.format === 'jsonl') {
            text = JSON.stringify(row) + '\n';
        } else if (this.format === 'csv') {
            const keys = Object.keys(row);
            if (this.count === 0) {
                text += keys.join(',') + '\n';
            }
            const line = keys.map(k => {
                const v = String(row[k] ?? '');
                return v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')
                    ? `"${v.replace(/"/g, '""')}"` : v;
            }).join(',');
            text += line + '\n';
        } else if (this.format === 'md' || this.format === 'markdown') {
            const keys = Object.keys(row);
            if (this.count === 0) {
                text += '| ' + keys.join(' | ') + ' |\n';
                text += '| ' + keys.map(() => '---').join(' | ') + ' |\n';
            }
            text += '| ' + keys.map(k => String(row[k] ?? '').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>')).join(' | ') + ' |\n';
        } else {
            // plain
            const entries = Object.entries(row).filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
            text = entries.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n';
        }

        this.count++;

        if (this.outputFilePath) {
            try {
                fs.appendFileSync(this.outputFilePath, text, 'utf8');
            } catch (err) {
                console.error(`[opencli:linkedin] Failed to write to file ${this.outputFilePath}: ${err.message}`);
            }
        }
        if (this.writeToStdout) {
            process.stdout.write(text);
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { process.removeListener('SIGINT', this.sigintHandler); } catch {}
        try { process.removeListener('SIGTERM', this.sigintHandler); } catch {}
        if (this.format === 'json') {
            const closeText = this.count === 0 ? '[]\n' : '\n]\n';
            if (this.outputFilePath) {
                try { fs.appendFileSync(this.outputFilePath, closeText, 'utf8'); } catch {}
            }
            if (this.writeToStdout) {
                process.stdout.write(closeText);
            }
        }
    }
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

// ── Offset / Cursor pagination for DOM extraction ─────────────────────
async function fetchJobCardsFromDom(page, input, options = {}) {
    const PAGE_SIZE = 25;
    const allJobs = [];
    const seenUrls = new Set();
    let currentStart = input.start;
    const referralSearchId = input.referralSearchId || generateReferralSearchId();

    const maxPages = Math.ceil(input.limit / PAGE_SIZE) + 2;
    let pagesFetched = 0;

    while (allJobs.length < input.limit && pagesFetched < maxPages) {
        if (pagesFetched > 0) {
            const targetUrl = buildJobSearchUrl({
                keywords: input.keywords,
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
            ? await enrichJobDetails(page, currentBatch, {
                onDetailFetched: (job, batchIndex) => {
                    const rankedJob = {
                        rank: input.start + allJobs.length + batchIndex + 1,
                        ...job,
                    };
                    options?.onDetailFetched?.(rankedJob);
                }
            })
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
async function fetchJobCards(page, input, options = {}) {
    const MAX_BATCH = 25;
    const allJobs = [];
    let offset = input.start;
    // Read JSESSIONID directly from the cookie store via CDP — zero page.evaluate round-trip
    const cookies = await page.getCookies?.({ url: 'https://www.linkedin.com' });
    const jsession = cookies?.find((c) => c.name === 'JSESSIONID')?.value;
    if (!jsession) {
        return await fetchJobCardsFromDom(page, input, options);
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
        return await fetchJobCardsFromDom(page, input, options);
    }

    return allJobs.slice(0, input.limit).map((item, index) => ({
        rank: input.start + index + 1,
        ...item,
    }));
}

// ── Job detail enrichment (--details flag) ────────────────────────────

async function clickJobCardInDom(page, job, index = 0) {
    const jobId = (job.url || '').match(/\/jobs\/view\/(\d+)/)?.[1] || '';
    const clicked = await page.evaluate(`((targetJobId, targetUrl, targetTitle, targetIndex) => {
        const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const cleanTitle = norm(targetTitle || '');

        function clickElement(el) {
            if (!el) return false;
            try { el.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch {}
            try { el.focus?.(); } catch {}
            const mouseOpts = { bubbles: true, cancelable: true, view: window, buttons: 1, detail: 1 };
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
                '[data-occludable-job-id="' + targetJobId + '"]'
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

        return { description, applyUrl: applyLink?.href || '' };
    })()`);

    return detail;
}

async function enrichJobDetails(page, jobs, options = {}) {
    const onDetailFetched = typeof options === 'function' ? options : options?.onDetailFetched;
    const enriched = [];
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        console.error(`[opencli:linkedin] Fetching details ${i + 1}/${jobs.length}: ${job.title}`);
        if (!job.url) {
            const reason = 'no url';
            console.error(`[opencli:linkedin] Skipping detail for "${job.title}": ${reason}`);
            const enrichedJob = { ...job, description: null, apply_url: null, detail_error: reason };
            enriched.push(enrichedJob);
            if (onDetailFetched) {
                try { onDetailFetched(enrichedJob, i); } catch (err) {
                    console.error(`[opencli:linkedin] Error in onDetailFetched: ${err.message}`);
                }
            }
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

            const detail_error = description ? null : 'missing description';
            const enrichedJob = {
                ...job,
                description: description || null,
                apply_url: apply_url || null,
                detail_error,
            };
            enriched.push(enrichedJob);
            if (onDetailFetched) {
                try { onDetailFetched(enrichedJob, i); } catch (err) {
                    console.error(`[opencli:linkedin] Error in onDetailFetched: ${err.message}`);
                }
            }
        }
        catch (err) {
            if (err instanceof AuthRequiredError)
                throw err;
            const reason = `fetch failed: ${err?.message || err}`;
            console.error(`[opencli:linkedin] Detail fetch failed for ${job.url}: ${reason}`);
            const enrichedJob = { ...job, description: null, apply_url: null, detail_error: reason };
            enriched.push(enrichedJob);
            if (onDetailFetched) {
                try { onDetailFetched(enrichedJob, i); } catch (cbErr) {
                    console.error(`[opencli:linkedin] Error in onDetailFetched: ${cbErr.message}`);
                }
            }
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
        { name: 'limit', type: 'int', default: 10, help: 'Number of jobs to return (max 100)' },
        { name: 'start', type: 'int', default: 0, help: 'Result offset for pagination' },
        { name: 'details', type: 'bool', default: false, help: 'Include full job description and apply URL (slower)' },
        { name: 'output', type: 'string', required: false, help: 'Optional file path to append results to directly' },
    ],
    columns: ['rank', 'title', 'company', 'location', 'listed', 'salary', 'url'],
    func: async (page, kwargs) => {
        const limit = parseIntegerArg(kwargs.limit, '--limit', 10, MIN_LIMIT, MAX_LIMIT);
        const start = parseIntegerArg(kwargs.start, '--start', 0, MIN_START);
        const includeDetails = Boolean(kwargs.details);
        const keywords = String(kwargs.query ?? '').trim();
        if (!keywords)
            throw new ArgumentError('query is required');

        const format = resolveOutputFormat(kwargs);
        const outputFile = resolveOutputFile(kwargs);
        const streamWriter = (includeDetails && (format !== 'table' || outputFile))
            ? new StreamWriter(format, outputFile)
            : null;

        const referralSearchId = generateReferralSearchId();
        const searchUrl = buildJobSearchUrl({ keywords, start, referralSearchId });
        await page.goto(searchUrl);
        await assertLinkedInAuthenticated(page, 'LinkedIn search');
        await page.wait({ text: 'Jobs', timeout: 10 });

        const input = {
            keywords,
            limit,
            start,
            includeDetails,
            referralSearchId,
        };

        const options = {
            onDetailFetched: (rankedJob) => {
                if (streamWriter) {
                    streamWriter.writeRow(rankedJob);
                }
            },
        };

        try {
            const data = await fetchJobCards(page, input, options);
            if (!includeDetails)
                return data;
            if (data.length > 0 && 'description' in data[0]) {
                if (streamWriter) {
                    streamWriter.close();
                    return streamWriter.writeToStdout ? null : data;
                }
                return data;
            }

            const enriched = await enrichJobDetails(page, data, {
                onDetailFetched: (job, index) => {
                    const rankedJob = {
                        rank: input.start + index + 1,
                        ...job,
                    };
                    if (streamWriter) {
                        streamWriter.writeRow(rankedJob);
                    }
                },
            });

            if (streamWriter) {
                streamWriter.close();
                return streamWriter.writeToStdout ? null : enriched;
            }
            return enriched;
        } finally {
            if (streamWriter) {
                streamWriter.close();
            }
        }
    },
});

export const __test__ = {
    parseIntegerArg,
    decodeLinkedinRedirect,
    looksLinkedInAuthWallText,
    assertLinkedInAuthenticated,
    enrichJobDetails,
    generateReferralSearchId,
    buildJobSearchUrl,
    extractJobCardsFromDom,
    fetchJobCardsFromDom,
    fetchJobCards,
    clickJobCardInDom,
    extractJobDetailsFromDom,
    StreamWriter,
    resolveOutputFormat,
    resolveOutputFile,
};
