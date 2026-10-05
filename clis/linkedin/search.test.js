import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import { __test__ } from './search.js';

const {
    parseIntegerArg,
    decodeLinkedinRedirect,
    looksLinkedInAuthWallText,
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
} = __test__;

const getSearchCommand = () => getRegistry().get('linkedin/search');

describe('linkedin argument validation', () => {
    it('rejects --limit outside 1..100 instead of silently clamping', () => {
        expect(() => parseIntegerArg(0, '--limit', 10, 1, 100)).toThrow(ArgumentError);
        expect(() => parseIntegerArg(101, '--limit', 10, 1, 100)).toThrow(ArgumentError);
        expect(() => parseIntegerArg('10.5', '--limit', 10, 1, 100)).toThrow(ArgumentError);
    });

    it('rejects negative --start instead of silently clamping to zero', () => {
        expect(() => parseIntegerArg(-1, '--start', 0, 0)).toThrow(ArgumentError);
        expect(parseIntegerArg(undefined, '--start', 0, 0)).toBe(0);
        expect(parseIntegerArg('25', '--start', 0, 0)).toBe(25);
    });

    it('validates command args before browser navigation', async () => {
        const command = getSearchCommand();
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn() };

        await expect(command.func(page, { query: 'engineer', limit: 0 })).rejects.toBeInstanceOf(ArgumentError);
        await expect(command.func(page, { query: 'engineer', start: -1 })).rejects.toBeInstanceOf(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
});

describe('linkedin auth wall detection', () => {
    it('recognizes login/authwall signals', () => {
        expect(looksLinkedInAuthWallText('https://www.linkedin.com/authwall?trk=guest Sign in to continue')).toBe(true);
        expect(looksLinkedInAuthWallText('LinkedIn Login, Sign in')).toBe(true);
        expect(looksLinkedInAuthWallText('About the job Senior infrastructure engineer')).toBe(false);
    });

    it('throws AuthRequiredError when search lands on a login wall', async () => {
        const command = getSearchCommand();
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue(true),
        };

        await expect(command.func(page, { query: 'engineer', limit: 5 })).rejects.toBeInstanceOf(AuthRequiredError);
    });
});

describe('linkedin decodeLinkedinRedirect', () => {
    it('extracts the underlying url from a /redir/redirect/ wrapper', () => {
        const target = 'https://example.com/jobs/apply?id=42';
        const wrapped = `https://www.linkedin.com/redir/redirect/?url=${encodeURIComponent(target)}&source=jobs`;
        expect(decodeLinkedinRedirect(wrapped)).toBe(target);
    });

    it('returns the input unchanged for non-redirect urls', () => {
        const direct = 'https://example.com/jobs/42/';
        expect(decodeLinkedinRedirect(direct)).toBe(direct);
    });

    it('returns empty string for falsy input', () => {
        expect(decodeLinkedinRedirect('')).toBe('');
        expect(decodeLinkedinRedirect(null)).toBe('');
    });
});

describe('linkedin enrichJobDetails (silent failure fix)', () => {
    function makeFakePage({ evaluateResults = [], gotoFails = [], evaluateFails = [] } = {}) {
        let evalCall = 0;
        let gotoCall = 0;
        return {
            goto: vi.fn(async () => {
                if (gotoFails[gotoCall++]) {
                    throw new Error(gotoFails[gotoCall - 1]);
                }
            }),
            wait: vi.fn(async () => undefined),
            evaluate: vi.fn(async (code) => {
                if (typeof code === 'string' && (code.includes('targetJobId') || code.includes('clickJobCard') || code.includes('targetIndex'))) {
                    return false;
                }
                const idx = evalCall++;
                if (evaluateFails[idx]) throw new Error(evaluateFails[idx]);
                return evaluateResults[idx];
            }),
        };
    }

    it('surfaces detail_error="no url" when row has no URL (instead of silent empty string)', async () => {
        const page = makeFakePage();
        const out = await enrichJobDetails(page, [
            { rank: 1, title: 'No URL Job', company: 'X', url: '' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            description: null,
            apply_url: null,
            detail_error: 'no url',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('surfaces detail_error="fetch failed: ..." when goto throws (no silent swallow)', async () => {
        const page = makeFakePage({ gotoFails: ['network down'] });
        const out = await enrichJobDetails(page, [
            { rank: 1, title: 'Fetch Fail', company: 'X', url: 'https://www.linkedin.com/jobs/view/1' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].description).toBeNull();
        expect(out[0].apply_url).toBeNull();
        expect(out[0].detail_error).toMatch(/^fetch failed: .*network down/);
    });

    it('surfaces detail_error="missing description" on empty description (signals upstream gap, not crash)', async () => {
        const page = makeFakePage({
            evaluateResults: [
                false, // auth wall probe
                undefined, // expand-show-more click result (ignored)
                { description: '', applyUrl: '' },
            ],
        });
        const out = await enrichJobDetails(page, [
            { rank: 1, title: 'Empty Desc', company: 'X', url: 'https://www.linkedin.com/jobs/view/2' },
        ]);
        expect(out[0].description).toBeNull();
        expect(out[0].apply_url).toBeNull();
        expect(out[0].detail_error).toBe('missing description');
    });

    it('surfaces detail_error=null on a fully successful enrichment', async () => {
        const page = makeFakePage({
            evaluateResults: [
                false, // auth wall probe
                undefined,
                { description: '  An interesting role  ', applyUrl: 'https://example.com/apply' },
            ],
        });
        const out = await enrichJobDetails(page, [
            { rank: 1, title: 'OK', company: 'X', url: 'https://www.linkedin.com/jobs/view/3' },
        ]);
        expect(out[0]).toMatchObject({
            description: 'An interesting role',
            apply_url: 'https://example.com/apply',
            detail_error: null,
        });
    });

    it('processes multiple rows with mixed outcomes without aborting the batch', async () => {
        const page = makeFakePage({
            evaluateResults: [
                // Row 1 (success)
                false,
                undefined,
                { description: 'Good', applyUrl: 'https://a.example/' },
                // Row 3 (success — row 2 had no URL so didn't navigate)
                false,
                undefined,
                { description: 'Also good', applyUrl: 'https://b.example/' },
            ],
        });
        const out = await enrichJobDetails(page, [
            { rank: 1, title: 'A', company: 'X', url: 'https://www.linkedin.com/jobs/view/10' },
            { rank: 2, title: 'B', company: 'X', url: '' },
            { rank: 3, title: 'C', company: 'X', url: 'https://www.linkedin.com/jobs/view/30' },
        ]);
        expect(out).toHaveLength(3);
        expect(out[0].detail_error).toBeNull();
        expect(out[1].detail_error).toBe('no url');
        expect(out[2].detail_error).toBeNull();
        // Goto was only called for rows with URL (1 and 3)
        expect(page.goto).toHaveBeenCalledTimes(2);
    });

    it('throws AuthRequiredError on detail auth wall instead of burying it in detail_error', async () => {
        const page = makeFakePage({ evaluateResults: [true] });

        await expect(enrichJobDetails(page, [
            { rank: 1, title: 'Needs Auth', company: 'X', url: 'https://www.linkedin.com/jobs/view/4' },
        ])).rejects.toBeInstanceOf(AuthRequiredError);
    });
});

describe('linkedin search URL builder (semantic search)', () => {
    it('generates a valid base64 referralSearchId', () => {
        const id = generateReferralSearchId();
        expect(id).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        const buffer = Buffer.from(id, 'base64');
        expect(buffer.length).toBe(16);
    });

    it('builds semantic search URL matching the required elements', () => {
        const url = buildJobSearchUrl({
            keywords: "senior aws devops fully remote jobs in Australia that doesn't need to be based in Australia contract or full-time or part-time posted in the past week",
            referralSearchId: 'uzo1ol6xZOlWpgHn0cy4Vw==',
        });
        expect(url).toBe(
            'https://www.linkedin.com/jobs/search-results/?keywords=senior+aws+devops+fully+remote+jobs+in+Australia+that+doesn%27t+need+to+be+based+in+Australia+contract+or+full-time+or+part-time+posted+in+the+past+week&origin=JOB_SEARCH_PAGE_JOB_FILTER&referralSearchId=uzo1ol6xZOlWpgHn0cy4Vw%3D%3D'
        );
    });


    it('generates a fresh referralSearchId if none is provided', () => {
        const url = buildJobSearchUrl({ keywords: 'software engineer' });
        expect(url).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/search-results\/\?keywords=software\+engineer&origin=JOB_SEARCH_PAGE_JOB_FILTER&referralSearchId=[A-Za-z0-9%]+$/);
    });

    it('navigates browser to semantic search URL on execution', async () => {
        const command = getSearchCommand();
        let navigatedUrl = '';
        const page = {
            goto: vi.fn().mockImplementation(async (url) => { navigatedUrl = url; }),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue(false),
        };

        try {
            await command.func(page, { query: 'aws devops in Australia', limit: 1 });
        } catch {
            // Further API calls in mock page may throw after navigation
        }

        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(navigatedUrl).toContain('https://www.linkedin.com/jobs/search-results/?');
        expect(navigatedUrl).toContain('keywords=aws+devops+in+Australia');
        expect(navigatedUrl).toContain('origin=JOB_SEARCH_PAGE_JOB_FILTER');
        expect(navigatedUrl).toContain('referralSearchId=');
        expect(navigatedUrl).not.toContain('/jobs/search/?');
    });
});

describe('linkedin extractJobCardsFromDom', () => {
    it('extracts jobs correctly from semantic search DOM elements', async () => {
        const html = `
            <div componentkey="job-card-component-ref-4375836267">
                <p><span class="b4la5p">Senior Cloud Engineer - AWS</span> (Verified job)</p>
                <div class="b4llzp"><p>Talenza</p></div>
                <p class="b4llzp">Sydney, NSW (Remote)</p>
                <span>Posted 3 days ago</span>
                <div>$160k AUD/yr - $175k AUD/yr</div>
            </div>
            <div componentkey="job-card-component-ref-4375359734">
                <p><span>Senior DevOps Engineer</span></p>
                <div class="b4llzp"><p>Humanify Tech</p></div>
                <p class="b4llzp">Australia (Remote)</p>
                <span>Posted 4 days ago</span>
            </div>
        `;
        const dom = new JSDOM(html);
        const page = {
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
        };

        const jobs = await extractJobCardsFromDom(page);
        expect(jobs).toHaveLength(2);
        expect(jobs[0]).toEqual({
            title: 'Senior Cloud Engineer - AWS',
            company: 'Talenza',
            location: 'Sydney, NSW (Remote)',
            listed: 'Posted 3 days ago',
            salary: '$160k AUD/yr - $175k AUD/yr',
            url: 'https://www.linkedin.com/jobs/view/4375836267',
        });
        expect(jobs[1]).toEqual({
            title: 'Senior DevOps Engineer',
            company: 'Humanify Tech',
            location: 'Australia (Remote)',
            listed: 'Posted 4 days ago',
            salary: '',
            url: 'https://www.linkedin.com/jobs/view/4375359734',
        });
    });

    it('deduplicates duplicate cards in the DOM', async () => {
        const html = `
            <div componentkey="job-card-component-ref-111">
                <p><span class="b4la5p">Engineer</span></p>
                <div class="b4llzp"><p>Company A</p></div>
                <p class="b4llzp">Remote</p>
            </div>
            <div componentkey="job-card-component-ref-111">
                <p><span class="b4la5p">Engineer</span></p>
                <div class="b4llzp"><p>Company A</p></div>
                <p class="b4llzp">Remote</p>
            </div>
        `;
        const dom = new JSDOM(html);
        const page = {
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
        };

        const jobs = await extractJobCardsFromDom(page);
        expect(jobs).toHaveLength(1);
    });

    it('extracts jobs with classic selector fallback', async () => {
        const html = `
            <div class="job-card-container" data-job-id="222">
                <a class="job-card-list__title" href="/jobs/view/222">Classic Engineer</a>
                <div class="job-card-container__company-name">Classic Corp</div>
                <div class="job-card-container__metadata-item">Melbourne, VIC</div>
                <time datetime="2026-10-01">2026-10-01</time>
            </div>
        `;
        const dom = new JSDOM(html);
        const page = {
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
        };

        const jobs = await extractJobCardsFromDom(page);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
            title: 'Classic Engineer',
            company: 'Classic Corp',
            location: 'Melbourne, VIC',
            listed: '2026-10-01',
            url: 'https://www.linkedin.com/jobs/view/222',
        });
    });
});

describe('linkedin fetchJobCards fallback to DOM', () => {
    it('falls back to DOM extraction when Voyager API returns empty elements', async () => {
        const dom = new JSDOM(`
            <div componentkey="job-card-component-ref-999">
                <p><span class="b4la5p">Semantic DevOps</span></p>
                <div class="b4llzp"><p>Cloud Corp</p></div>
                <p class="b4llzp">Australia (Remote)</p>
                <span>Posted 2 days ago</span>
            </div>
        `);
        const page = {
            getCookies: vi.fn().mockResolvedValue([{ name: 'JSESSIONID', value: '"ajax:12345"' }]),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ elements: [] })
                .mockImplementation(async (code) => {
                    const fn = new Function('document', 'window', `return ${code}`);
                    return fn(dom.window.document, dom.window);
                }),
        };

        const input = {
            keywords: 'aws devops',
            limit: 10,
            start: 0,
        };

        const jobs = await fetchJobCards(page, input);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toEqual({
            rank: 1,
            title: 'Semantic DevOps',
            company: 'Cloud Corp',
            location: 'Australia (Remote)',
            listed: 'Posted 2 days ago',
            salary: '',
            url: 'https://www.linkedin.com/jobs/view/999',
        });
    });

    it('returns Voyager API results when available without invoking DOM extraction', async () => {
        const page = {
            getCookies: vi.fn().mockResolvedValue([{ name: 'JSESSIONID', value: '"ajax:12345"' }]),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValueOnce({
                elements: [{
                    jobCardUnion: {
                        jobPostingCard: {
                            jobPostingUrn: 'urn:li:fsd_jobPosting:888',
                            jobPostingTitle: 'Voyager DevOps',
                            primaryDescription: { text: 'Voyager Corp' },
                            secondaryDescription: { text: 'Sydney, NSW' },
                            footerItems: [{ type: 'LISTED_DATE', timeAt: 1700000000000 }],
                        },
                    },
                }],
            }),
        };

        const input = {
            keywords: 'aws devops',
            limit: 5,
            start: 0,
        };

        const jobs = await fetchJobCards(page, input);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].title).toBe('Voyager DevOps');
        expect(jobs[0].url).toBe('https://www.linkedin.com/jobs/view/888');
    });
});

describe('linkedin fetchJobCardsFromDom (cursor / offset pagination & limit)', () => {
    function makePageWithCards(pagesData) {
        let currentPageIndex = 0;
        return {
            goto: vi.fn().mockImplementation(async () => {
                currentPageIndex++;
            }),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockImplementation(async (code) => {
                if (typeof code === 'string' && code.includes('looksLinkedInAuthWallText')) {
                    return false;
                }
                const cards = pagesData[currentPageIndex] || [];
                return cards;
            }),
        };
    }

    it('only returns up to limit when limit is smaller than page size', async () => {
        const page0 = Array.from({ length: 25 }, (_, i) => ({
            title: `Job ${i + 1}`,
            company: 'Acme',
            location: 'Remote',
            listed: '1d ago',
            salary: '',
            url: `https://www.linkedin.com/jobs/view/${1000 + i}`,
        }));
        const page = makePageWithCards([page0]);

        const jobs = await fetchJobCardsFromDom(page, {
            keywords: 'devops',
            location: 'Australia',
            limit: 5,
            start: 0,
        });

        expect(jobs).toHaveLength(5);
        expect(jobs.map(j => j.rank)).toEqual([1, 2, 3, 4, 5]);
        expect(jobs[0].title).toBe('Job 1');
        expect(jobs[4].title).toBe('Job 5');
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('paginates across pages and returns exactly limit items', async () => {
        const page0 = Array.from({ length: 25 }, (_, i) => ({
            title: `Job ${i + 1}`,
            company: 'Acme',
            location: 'Remote',
            listed: '1d ago',
            salary: '',
            url: `https://www.linkedin.com/jobs/view/${1000 + i}`,
        }));
        const page1 = Array.from({ length: 25 }, (_, i) => ({
            title: `Job ${i + 26}`,
            company: 'Acme',
            location: 'Remote',
            listed: '1d ago',
            salary: '',
            url: `https://www.linkedin.com/jobs/view/${2000 + i}`,
        }));
        const page = makePageWithCards([page0, page1]);

        const jobs = await fetchJobCardsFromDom(page, {
            keywords: 'devops',
            limit: 30,
            start: 0,
        });

        expect(jobs).toHaveLength(30);
        expect(jobs[0].rank).toBe(1);
        expect(jobs[24].title).toBe('Job 25');
        expect(jobs[25].title).toBe('Job 26');
        expect(jobs[29].title).toBe('Job 30');
        expect(jobs[29].rank).toBe(30);
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('start=25'));
    });

    it('honors start offset for ranking', async () => {
        const page0 = Array.from({ length: 25 }, (_, i) => ({
            title: `Job ${i + 1}`,
            company: 'Acme',
            location: 'Remote',
            listed: '1d ago',
            salary: '',
            url: `https://www.linkedin.com/jobs/view/${1000 + i}`,
        }));
        const page = makePageWithCards([page0]);

        const jobs = await fetchJobCardsFromDom(page, {
            keywords: 'devops',
            limit: 5,
            start: 10,
        });

        expect(jobs).toHaveLength(5);
        expect(jobs.map(j => j.rank)).toEqual([11, 12, 13, 14, 15]);
    });

    it('stops pagination when no more jobs are returned', async () => {
        const page0 = [
            { title: 'Job 1', company: 'Acme', location: 'Remote', listed: '', salary: '', url: 'https://www.linkedin.com/jobs/view/1' },
        ];
        const page = makePageWithCards([page0]);

        const jobs = await fetchJobCardsFromDom(page, {
            keywords: 'devops',
            limit: 50,
            start: 0,
        });

        expect(jobs).toHaveLength(1);
    });

    it('enriches entries page-by-page from top to bottom before going to the next page when includeDetails is true', async () => {
        const page0 = [
            { title: 'Job 1', company: 'Acme', location: 'Remote', listed: '', salary: '', url: 'https://www.linkedin.com/jobs/view/1' },
            { title: 'Job 2', company: 'Acme', location: 'Remote', listed: '', salary: '', url: 'https://www.linkedin.com/jobs/view/2' },
        ];
        const page = makePageWithCards([page0]);
        const origEvaluate = page.evaluate;
        page.evaluate = vi.fn(async (code) => {
            if (typeof code === 'string' && (code.includes('targetJobId') || code.includes('targetIndex'))) {
                return false;
            }
            if (typeof code === 'string' && code.includes('login__form')) {
                return false;
            }
            if (typeof code === 'string' && code.includes('About the job')) {
                return { description: 'Detail for job', applyUrl: 'https://example.com/apply', hiringTeam: null };
            }
            return origEvaluate(code);
        });

        const jobs = await fetchJobCardsFromDom(page, {
            keywords: 'devops',
            limit: 2,
            start: 0,
            includeDetails: true,
        });

        expect(jobs).toHaveLength(2);
        expect(jobs[0].description).toBe('Detail for job');
        expect(jobs[1].description).toBe('Detail for job');
        expect(jobs[0].rank).toBe(1);
        expect(jobs[1].rank).toBe(2);
    });
});

describe('linkedin immediate streaming to stdout and file on detail fetch', () => {
    it('formats and streams each detail row as valid YAML when format is yaml', () => {
        let stdoutText = '';
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
            stdoutText += text;
            return true;
        });

        const writer = new StreamWriter('yaml', null);
        writer.writeRow({ rank: 1, title: 'DevOps Lead', description: 'AWS experience required' });
        writer.writeRow({ rank: 2, title: 'Site Reliability Engineer', description: 'Kubernetes expert' });
        writer.close();

        writeSpy.mockRestore();

        expect(stdoutText).toContain('- rank: 1\n  title: DevOps Lead\n  description: AWS experience required\n');
        expect(stdoutText).toContain('- rank: 2\n  title: Site Reliability Engineer\n  description: Kubernetes expert\n');
    });

    it('formats and streams each detail row as valid JSON array when format is json', () => {
        let stdoutText = '';
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
            stdoutText += text;
            return true;
        });

        const writer = new StreamWriter('json', null);
        writer.writeRow({ rank: 1, title: 'DevOps Lead' });
        writer.writeRow({ rank: 2, title: 'Site Reliability Engineer' });
        writer.close();

        writeSpy.mockRestore();

        expect(stdoutText.startsWith('[\n')).toBe(true);
        expect(stdoutText.trim().endsWith(']')).toBe(true);
        const parsed = JSON.parse(stdoutText);
        expect(parsed).toEqual([
            { rank: 1, title: 'DevOps Lead' },
            { rank: 2, title: 'Site Reliability Engineer' },
        ]);
    });

    it('formats and streams each detail row as CSV with header on first row', () => {
        let stdoutText = '';
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
            stdoutText += text;
            return true;
        });

        const writer = new StreamWriter('csv', null);
        writer.writeRow({ rank: 1, title: 'DevOps Lead', company: 'Acme Corp' });
        writer.writeRow({ rank: 2, title: 'SRE', company: 'Beta, Inc.' });
        writer.close();

        writeSpy.mockRestore();

        const lines = stdoutText.trim().split('\n');
        expect(lines[0]).toBe('rank,title,company');
        expect(lines[1]).toBe('1,DevOps Lead,Acme Corp');
        expect(lines[2]).toBe('2,SRE,"Beta, Inc."');
    });

    it('does not stream to stdout when format is table', () => {
        let stdoutCalled = false;
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
            stdoutCalled = true;
            return true;
        });

        const writer = new StreamWriter('table', null);
        writer.writeRow({ rank: 1, title: 'DevOps Lead' });
        writer.close();

        writeSpy.mockRestore();

        expect(stdoutCalled).toBe(false);
    });

    it('resolves format from kwargs, CLI flags, file extension, and fallback', () => {
        expect(resolveOutputFormat({ format: 'json' })).toBe('json');
        expect(resolveOutputFormat({ output: 'jobs.yml' })).toBe('yaml');
        expect(resolveOutputFormat({ file: 'jobs.json' })).toBe('json');
        expect(resolveOutputFile({ output: 'my-jobs.yml' })).toBe('my-jobs.yml');
        expect(resolveOutputFile({ file: 'my-jobs.json' })).toBe('my-jobs.json');
    });

    it('invokes onDetailFetched callback immediately for each enriched job without hiring_team', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (code) => {
                if (typeof code === 'string' && (code.includes('targetJobId') || code.includes('clickJobCard') || code.includes('targetIndex'))) {
                    return false;
                }
                if (typeof code === 'string' && code.includes('login__form')) {
                    return false;
                }
                if (typeof code === 'string' && code.includes('About the job')) {
                    return {
                        description: 'Great job description without hiring team',
                        applyUrl: 'https://example.com/apply',
                    };
                }
                return undefined;
            }),
        };

        const fetchedStream = [];
        const enriched = await enrichJobDetails(page, [
            { rank: 1, title: 'DevOps Lead', company: 'CloudCo', url: 'https://www.linkedin.com/jobs/view/999' },
            { rank: 2, title: 'Cloud Architect', company: 'AWSCo', url: 'https://www.linkedin.com/jobs/view/888' },
        ], {
            onDetailFetched: (job) => {
                fetchedStream.push(job);
            },
        });

        expect(fetchedStream).toHaveLength(2);
        expect(fetchedStream[0].title).toBe('DevOps Lead');
        expect(fetchedStream[0].description).toBe('Great job description without hiring team');
        expect(fetchedStream[0]).not.toHaveProperty('hiring_team');
        expect(fetchedStream[1].title).toBe('Cloud Architect');
        expect(fetchedStream[1]).not.toHaveProperty('hiring_team');
        expect(enriched).toHaveLength(2);
    });
});

describe('linkedin in-page job card clicking and details extraction', () => {
    it('clicks the non-hyperlink card entry container in workspace list hierarchy to load details in-place', async () => {
        const dom = new JSDOM(`
            <div id="workspace">
                <div class="workspace-main">
                    <div class="search-layout">
                        <div class="results-list-container">
                            <div class="results-list">
                                <div class="entry-card-1">
                                    <div class="entry-card-wrapper">
                                        <div class="entry-card-container">
                                            <a href="/jobs/view/123456" class="job-card-title">Senior DevOps Specialist</a>
                                            <div class="entry-card-content">
                                                <div id="clickable-entry-1">
                                                    <p>CloudCo</p>
                                                    <p>Sydney, NSW</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="jobs-search__job-details--container">
                <span class="about-title">About the job</span>
                <p>Cloud and DevOps Engineer details in-place.</p>
                <a href="https://example.com/apply/inplace">Apply inplace</a>
                <div role="alert" title="Meet the hiring team">
                    <a href="https://www.linkedin.com/in/hiring-manager">Jane Manager</a>
                    <div>Engineering Lead</div>
                </div>
            </div>
        `);

        let targetClicked = false;
        const targetEl = dom.window.document.querySelector('#clickable-entry-1');
        targetEl.addEventListener('click', () => { targetClicked = true; });

        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
        };

        const [enriched] = await enrichJobDetails(page, [
            {
                rank: 1,
                title: 'Senior DevOps Specialist',
                company: 'CloudCo',
                url: 'https://www.linkedin.com/jobs/view/123456',
            },
        ]);

        expect(page.goto).not.toHaveBeenCalled();
        expect(targetClicked).toBe(true);
        expect(enriched.description).toContain('Cloud and DevOps Engineer details in-place.');
        expect(enriched.apply_url).toBe('https://example.com/apply/inplace');
        expect(enriched).not.toHaveProperty('hiring_team');
        expect(enriched.detail_error).toBeNull();
    });

    it('clicks the non-hyperlink part of the job entry card in the DOM and extracts right-side details without calling page.goto or clicking the title link', async () => {
        const dom = new JSDOM(`
            <div componentkey="job-card-component-ref-4375836267" class="job-card-container">
                <a class="job-card-list__title" href="/jobs/view/4375836267">Senior Cloud Engineer - AWS</a>
                <div class="job-card-body">
                    <p class="company-name">Talenza</p>
                </div>
            </div>
            <div class="jobs-search__job-details--container">
                <h2>About the job</h2>
                <p>We are seeking a Senior AWS Cloud Engineer with deep Terraform and Kubernetes experience.</p>
                <a href="https://example.com/apply/aws-cloud">Apply externally</a>
                <div role="alert" title="Meet the hiring team">
                    <a href="https://www.linkedin.com/in/sarah-recruiter">Sarah Recruiter</a>
                    <div class="hirer-headline">Talent Partner @ CloudCo</div>
                </div>
            </div>
        `);
        let linkClicked = false;
        let cardNonLinkClicked = false;
        const card = dom.window.document.querySelector('.job-card-container');
        const cardLink = dom.window.document.querySelector('a.job-card-list__title');
        cardLink.addEventListener('click', () => { linkClicked = true; });
        card.addEventListener('click', (e) => {
            if (!e.target.closest('a')) {
                cardNonLinkClicked = true;
            }
        });

        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
        };

        const [enriched] = await enrichJobDetails(page, [
            {
                rank: 1,
                title: 'Senior Cloud Engineer - AWS',
                company: 'Talenza',
                url: 'https://www.linkedin.com/jobs/view/4375836267',
            },
        ]);

        expect(page.goto).not.toHaveBeenCalled();
        expect(cardNonLinkClicked).toBe(true);
        expect(linkClicked).toBe(false);
        expect(enriched.description).toContain('Senior AWS Cloud Engineer');
        expect(enriched.apply_url).toBe('https://example.com/apply/aws-cloud');
        expect(enriched).not.toHaveProperty('hiring_team');
        expect(enriched.detail_error).toBeNull();
    });

    it('falls back to page.goto when job card is not present in the search page DOM', async () => {
        const dom = new JSDOM(`
            <div class="job-details-page">
                <h2>About the job</h2>
                <p>Fallback job description via page navigation.</p>
                <a href="https://example.com/apply/fallback">Apply</a>
            </div>
        `);
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (code) => {
                if (typeof code === 'string' && (code.includes('targetJobId') || code.includes('targetIndex'))) {
                    // Card not in DOM
                    return false;
                }
                if (typeof code === 'string' && code.includes('login__form')) {
                    // Auth probe
                    return false;
                }
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
        };

        const [enriched] = await enrichJobDetails(page, [
            {
                rank: 1,
                title: 'Remote DevOps Engineer',
                company: 'RemoteCo',
                url: 'https://www.linkedin.com/jobs/view/888888',
            },
        ]);

        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.goto).toHaveBeenCalledWith('https://www.linkedin.com/jobs/view/888888');
        expect(enriched.description).toContain('Fallback job description via page navigation.');
        expect(enriched.apply_url).toBe('https://example.com/apply/fallback');
        expect(enriched.detail_error).toBeNull();
    });

    it('does not click "Learn more filter" or filter buttons when expanding job description', async () => {
        const dom = new JSDOM(`
            <header>
                <div class="search-reusables__filter-list">
                    <button id="learn-more-filter" aria-label="Learn more filter">Learn more</button>
                    <button id="more-filters" aria-label="All filters">More filters</button>
                </div>
            </header>
            <div class="semantic-details-pane">
                <h2>About the job</h2>
                <div class="job-details-content">
                    <p>Job content here</p>
                    <button id="show-more-desc" aria-label="Show more description">Show more</button>
                </div>
            </div>
        `);

        let learnMoreClicked = false;
        let moreFiltersClicked = false;
        let showMoreClicked = false;

        dom.window.document.querySelector('#learn-more-filter').addEventListener('click', () => {
            learnMoreClicked = true;
        });
        dom.window.document.querySelector('#more-filters').addEventListener('click', () => {
            moreFiltersClicked = true;
        });
        dom.window.document.querySelector('#show-more-desc').addEventListener('click', () => {
            showMoreClicked = true;
        });

        const page = {
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
            wait: vi.fn().mockResolvedValue(undefined),
        };

        await extractJobDetailsFromDom(page);

        expect(learnMoreClicked).toBe(false);
        expect(moreFiltersClicked).toBe(false);
        expect(showMoreClicked).toBe(true);
    });

    it('clicks "...more" button to expand full job description', async () => {
        const dom = new JSDOM(`
            <div class="semantic-details-pane">
                <h2>About the job</h2>
                <div class="job-details-content">
                    <p>Short snippet of AWS DevOps role</p>
                    <button id="ellipsis-more-btn" class="inline-show-more-text__button">...more</button>
                </div>
            </div>
        `);

        let ellipsisMoreClicked = false;
        dom.window.document.querySelector('#ellipsis-more-btn').addEventListener('click', () => {
            ellipsisMoreClicked = true;
        });

        const page = {
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
            wait: vi.fn().mockResolvedValue(undefined),
        };

        await extractJobDetailsFromDom(page);

        expect(ellipsisMoreClicked).toBe(true);
    });

    it('clicks "…more" (unicode ellipsis) button to expand full job description', async () => {
        const dom = new JSDOM(`
            <div class="semantic-details-pane">
                <h2>About the job</h2>
                <div class="job-details-content">
                    <p>Short snippet of AWS DevOps role</p>
                    <button id="unicode-more-btn" class="inline-show-more-text__button">…more</button>
                </div>
            </div>
        `);

        let unicodeMoreClicked = false;
        dom.window.document.querySelector('#unicode-more-btn').addEventListener('click', () => {
            unicodeMoreClicked = true;
        });

        const page = {
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
            wait: vi.fn().mockResolvedValue(undefined),
        };

        await extractJobDetailsFromDom(page);

        expect(unicodeMoreClicked).toBe(true);
    });

    it('clicks button with data-testid="expandable-text-button" to expand job details and cleans trailing more', async () => {
        const dom = new JSDOM(`
            <div class="semantic-details-pane">
                <h2>About the job</h2>
                <div class="job-details-content">
                    <p>
                        Senior DevOps Engineer with AWS experience.
                        <button class="ckymsq ckymst" type="button" aria-hidden="true" data-testid="expandable-text-button" style="display: inline-block;">
                            <span style="white-space: nowrap;"><span><span>…</span><span> more</span></span></span>
                        </button>
                    </p>
                </div>
            </div>
        `);

        let expandableClicked = false;
        const btn = dom.window.document.querySelector('button[data-testid="expandable-text-button"]');
        btn.addEventListener('click', () => {
            expandableClicked = true;
            btn.remove();
        });

        const page = {
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
            wait: vi.fn().mockResolvedValue(undefined),
        };

        const result = await extractJobDetailsFromDom(page);

        expect(expandableClicked).toBe(true);
        expect(result.description).not.toMatch(/more$/i);
        expect(result.description).toContain('Senior DevOps Engineer with AWS experience.');
    });

    it('does not throw TypeError when rightPane is null or details are not yet loaded', async () => {
        const dom = new JSDOM(`
            <div class="search-results-only">
                <p>Waiting for user to select a job...</p>
            </div>
        `);

        const page = {
            evaluate: vi.fn(async (code) => {
                const fn = new Function('document', 'window', `return ${code}`);
                return fn(dom.window.document, dom.window);
            }),
            wait: vi.fn().mockResolvedValue(undefined),
        };

        const result = await extractJobDetailsFromDom(page);

        expect(result).toBeDefined();
        expect(result.description).toBe('');
        expect(result.applyUrl).toBe('');
        expect(result.hiringTeam).toBeUndefined();
    });
});



