import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

const BASE_URL = 'https://www.portalinmobiliario.com';
const RESULTS_PER_PAGE = 48;

const cleanText = (value) => (value || '').replace(/\s+/g, ' ').trim();

const decodeHtmlEntities = (value) =>
    (value || '')
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>');

const normalizeListingUrl = (url) => {
    if (!url) return null;
    const decoded = decodeHtmlEntities(url).trim();
    const absolute = decoded.startsWith('http') ? decoded : `${BASE_URL}${decoded.startsWith('/') ? '' : '/'}${decoded}`;
    try {
        const parsed = new URL(absolute);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return null;
    }
};

const extractListingId = (value) => {
    const match = (value || '').match(/MLC-\d+/i);
    return match ? match[0].toUpperCase() : null;
};

const parseNumber = (value) => {
    if (value == null) return null;
    const normalized = String(value).replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
    if (!normalized) return null;
    const asNumber = Number(normalized);
    return Number.isNaN(asNumber) ? null : asNumber;
};

const parsePrice = (priceText) => {
    const raw = cleanText(priceText);
    if (!raw) return { rawPrice: null, price: null, currency: null };

    const currency = /\bUF\b/i.test(raw) ? 'UF' : /\bCLP\b|\$/i.test(raw) ? 'CLP' : null;
    const numericMatch = raw.match(/[\d.,]+/);
    const price = numericMatch ? parseNumber(numericMatch[0]) : null;

    return { rawPrice: raw, price, currency };
};

const parseSummaryByRegex = (text) => {
    const body = cleanText(text);
    const bedrooms = body.match(/(\d+)\s*dormitorios?/i)?.[1] ?? null;
    const bathrooms = body.match(/(\d+)\s*bañ(?:o|os)/i)?.[1] ?? null;
    const parking = body.match(/(\d+)\s*estacionamientos?/i)?.[1] ?? null;
    const storage = body.match(/(\d+)\s*bodegas?/i)?.[1] ?? null;
    const areas = [...body.matchAll(/(\d+[.,]?\d*)\s*m²/gi)].map((m) => m[0]);

    const maintenanceMatch = body.match(/gastos?\s+comunes?[^\d]{0,20}([\d.\s,]+(?:UF|CLP)?)/i);
    const maintenanceFee = maintenanceMatch ? cleanText(maintenanceMatch[1]) : null;

    return {
        bedrooms: bedrooms ? Number(bedrooms) : null,
        bathrooms: bathrooms ? Number(bathrooms) : null,
        parking: parking ? Number(parking) : null,
        storage: storage ? Number(storage) : null,
        useful_area: areas[0] || null,
        total_area: areas[1] || null,
        maintenance_fee: maintenanceFee,
    };
};

const getJsonLdObjects = ($) => {
    const output = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) output.push(...parsed);
            else output.push(parsed);
        } catch {
            // Ignore malformed JSON-LD blocks.
        }
    });
    return output;
};

const extractListingUrlsFromSearch = ($) => {
    const results = [];
    $('a[href*="MLC-"]').each((_, el) => {
        const href = $(el).attr('href');
        const normalized = normalizeListingUrl(href);
        if (!normalized) return;
        if (!normalized.includes('portalinmobiliario.com/MLC-')) return;
        results.push(normalized);
    });
    return [...new Set(results)];
};

const extractOverviewForUrl = ($, listingUrl, pageNumber) => {
    const listingId = extractListingId(listingUrl);
    const anchor = listingId ? $(`a[href*="${listingId}"]`).first() : null;
    const card = anchor && anchor.length ? anchor.closest('li,article,div') : null;
    const title =
        cleanText(card?.find('h2,h3').first().text()) ||
        cleanText(anchor?.find('h2,h3').first().text()) ||
        cleanText(anchor?.text()) ||
        null;
    const priceText =
        cleanText(card?.find('.andes-money-amount,[class*="price"]').first().text()) || null;
    const location =
        cleanText(card?.find('[class*="location"],[class*="address"]').first().text()) || null;
    const thumbnail = card?.find('img').first().attr('src') || null;
    const priceInfo = parsePrice(priceText);

    return {
        source: 'overview',
        page: pageNumber,
        id: listingId,
        url: listingUrl,
        propertyTitle: title,
        location,
        thumbnail,
        ...priceInfo,
    };
};

const buildSearchUrl = ({ operation, propertyType, location, condition, searchUrl }) => {
    if (searchUrl) return searchUrl;
    const segments = [operation || 'venta', propertyType || 'departamento'];
    if (condition && condition !== 'any') segments.push(condition);
    segments.push(location || 'santiago-metropolitana');
    return `${BASE_URL}/${segments.map((segment) => segment.replace(/^\/+|\/+$/g, '')).join('/')}`;
};

const buildNextPageUrl = (currentUrl, pageNumber) => {
    const offset = (pageNumber - 1) * RESULTS_PER_PAGE + 1;
    const suffix = `_Desde_${offset}_NoIndex_True`;
    const url = decodeHtmlEntities(currentUrl);
    if (/_Desde_\d+_NoIndex_True/i.test(url)) return url.replace(/_Desde_\d+_NoIndex_True/i, suffix);
    return `${url.replace(/\/$/, '')}${suffix}`;
};

const extractDetail = ($, request, overview) => {
    const fullText = cleanText($('body').text());
    const jsonLd = getJsonLdObjects($);
    const product = jsonLd.find((obj) => {
        const type = Array.isArray(obj?.['@type']) ? obj['@type'][0] : obj?.['@type'];
        return ['Product', 'Residence', 'SingleFamilyResidence', 'Apartment'].includes(type);
    });

    const geoSource = jsonLd.find((obj) => obj?.geo || obj?.address)?.geo || product?.geo || {};
    const imageList = [
        ...(Array.isArray(product?.image) ? product.image : product?.image ? [product.image] : []),
        $('meta[property="og:image"]').attr('content'),
    ].filter(Boolean);

    const title =
        cleanText($('h1').first().text()) ||
        cleanText(product?.name) ||
        cleanText($('meta[property="og:title"]').attr('content')) ||
        null;

    const priceText =
        cleanText($('[class*="price"], .ui-pdp-price__second-line').first().text()) ||
        cleanText(product?.offers?.priceCurrency && product?.offers?.price
            ? `${product.offers.price} ${product.offers.priceCurrency}`
            : null);

    const priceInfo = parsePrice(priceText);
    const summary = parseSummaryByRegex(fullText);

    return {
        ...overview,
        source: 'detail',
        id: overview.id || extractListingId(request.loadedUrl || request.url),
        url: request.loadedUrl || request.url,
        propertyTitle: title || overview.propertyTitle || null,
        description: cleanText($('meta[name="description"]').attr('content')) || null,
        location:
            cleanText($('[class*="location"], [class*="address"]').first().text()) ||
            cleanText(product?.address?.streetAddress) ||
            overview.location ||
            null,
        latitude: parseNumber(geoSource?.latitude ?? null),
        longitude: parseNumber(geoSource?.longitude ?? null),
        images: [...new Set(imageList)],
        thumbnail: overview.thumbnail || imageList[0] || null,
        ...priceInfo,
        ...summary,
    };
};

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    scrapeMode = 'overview',
    searchMode = 'byPlace',
    operation = 'venta',
    propertyType = 'departamento',
    location = 'santiago-metropolitana',
    condition = 'any',
    searchUrl,
    listingUrls = [],
    maxResults = 100,
    maxPages = 5,
    proxyConfiguration,
} = input;

if (searchMode === 'bySearchUrl' && !searchUrl) {
    throw new Error('searchUrl is required when searchMode is "bySearchUrl".');
}

if (searchMode === 'byListingUrl' && (!Array.isArray(listingUrls) || listingUrls.length === 0)) {
    throw new Error('listingUrls must contain at least one URL when searchMode is "byListingUrl".');
}

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
const requestQueue = await Actor.openRequestQueue();

const seenSearchUrls = new Set();
const seenListingUrls = new Set();
let outputCount = 0;

if (searchMode === 'byListingUrl') {
    for (const rawUrl of listingUrls) {
        const normalized = normalizeListingUrl(rawUrl);
        if (!normalized || seenListingUrls.has(normalized)) continue;
        seenListingUrls.add(normalized);
        await requestQueue.addRequest({
            url: normalized,
            userData: {
                label: 'DETAIL',
                overview: {
                    source: 'overview',
                    id: extractListingId(normalized),
                    url: normalized,
                },
            },
        });
    }
} else {
    const initialSearchUrl = buildSearchUrl({ operation, propertyType, location, condition, searchUrl });
    seenSearchUrls.add(initialSearchUrl);
    await requestQueue.addRequest({
        url: initialSearchUrl,
        userData: { label: 'SEARCH', page: 1 },
    });
}

const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration: proxy,
    maxRequestRetries: 2,
    async requestHandler({ request, $, log: crawlerLog }) {
        if (outputCount >= maxResults) return;

        if (request.userData.label === 'SEARCH') {
            const pageNumber = request.userData.page || 1;
            const listingPageUrls = extractListingUrlsFromSearch($);
            crawlerLog.info(`Search page ${pageNumber}: found ${listingPageUrls.length} listing URLs.`);

            let addedFromPage = 0;
            for (const listingUrl of listingPageUrls) {
                if (outputCount >= maxResults) break;
                if (seenListingUrls.has(listingUrl)) continue;
                seenListingUrls.add(listingUrl);

                const overview = extractOverviewForUrl($, listingUrl, pageNumber);
                if (scrapeMode === 'overview') {
                    await Actor.pushData(overview);
                    outputCount += 1;
                } else {
                    await requestQueue.addRequest({
                        url: listingUrl,
                        userData: { label: 'DETAIL', overview },
                    });
                }
                addedFromPage += 1;
            }

            if (
                pageNumber < maxPages &&
                outputCount < maxResults &&
                addedFromPage > 0 &&
                searchMode !== 'byListingUrl'
            ) {
                const nextPage = pageNumber + 1;
                const nextUrl = buildNextPageUrl(request.loadedUrl || request.url, nextPage);
                if (!seenSearchUrls.has(nextUrl)) {
                    seenSearchUrls.add(nextUrl);
                    await requestQueue.addRequest({
                        url: nextUrl,
                        userData: { label: 'SEARCH', page: nextPage },
                    });
                }
            }
            return;
        }

        if (request.userData.label === 'DETAIL') {
            const detail = extractDetail($, request, request.userData.overview || {});
            await Actor.pushData(detail);
            outputCount += 1;
            crawlerLog.info(`Saved detail ${outputCount}/${maxResults}: ${detail.id || detail.url}`);
        }
    },
    failedRequestHandler({ request }) {
        log.error(`Request failed after retries: ${request.url}`);
    },
});

await crawler.run();
await Actor.exit();
