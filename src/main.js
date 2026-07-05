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

const decodeJsonEscapedText = (value) => {
    if (!value) return null;
    return value
        .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"');
};

const parseIntOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isNaN(parsed) ? null : parsed;
};

const parsePositiveIntWithDefault = (value, defaultValue) => {
    const parsed = parseIntOrNull(value);
    if (parsed == null || parsed <= 0) return defaultValue;
    return parsed;
};

const buildFilters = (input) => ({
    minPrice: parseNumber(input.minPrice),
    maxPrice: parseNumber(input.maxPrice),
    minBedrooms: parseIntOrNull(input.minBedrooms),
    maxBedrooms: parseIntOrNull(input.maxBedrooms),
    minBathrooms: parseIntOrNull(input.minBathrooms),
    maxBathrooms: parseIntOrNull(input.maxBathrooms),
    minParking: parseIntOrNull(input.minParking),
});

const withinRange = (value, min, max) => {
    if (min == null && max == null) return true;
    if (value == null) return false;
    if (min != null && value < min) return false;
    if (max != null && value > max) return false;
    return true;
};

const matchesFilters = (item, filters) =>
    withinRange(item.price, filters.minPrice, filters.maxPrice) &&
    withinRange(item.bedrooms, filters.minBedrooms, filters.maxBedrooms) &&
    withinRange(item.bathrooms, filters.minBathrooms, filters.maxBathrooms) &&
    withinRange(item.parking, filters.minParking, null);

const currencyFromPortalCode = (value) => {
    if (value === 'CLF') return 'UF';
    if (value === 'CLP') return 'CLP';
    if (value === 'USD') return 'US$';
    return value || null;
};

const parseSummaryByRegex = (text) => {
    const body = cleanText(text);
    const bedrooms = body.match(/(\d+)\s*dormitorios?/i)?.[1] ?? null;
    const bathrooms = body.match(/(\d+)\s*b(?:añ|an)(?:o|os)/i)?.[1] ?? null;
    const parking = body.match(/(\d+)\s*estacionamientos?/i)?.[1] ?? null;
    const storage = body.match(/(\d+)\s*bodegas?/i)?.[1] ?? null;
    const usefulAreaMatch = body.match(/(\d+\s*-\s*\d+|\d+[.,]?\d*)\s*m(?:²|2)?\s*útiles?/i);
    const totalAreaMatch = body.match(/(\d+\s*-\s*\d+|\d+[.,]?\d*)\s*m(?:²|2)?\s*totales?/i);

    let usefulArea = usefulAreaMatch ? `${usefulAreaMatch[1]} m² útiles` : null;
    let totalArea = totalAreaMatch ? `${totalAreaMatch[1]} m² totales` : null;

    // Fallback for pages where areas are unlabeled and shown as two values.
    if (!usefulArea || !totalArea) {
        const genericAreas = [...body.matchAll(/(\d+\s*-\s*\d+|\d+[.,]?\d*)\s*m(?:²|2)/gi)].map((m) => m[1]);
        if (!usefulArea && genericAreas[0]) usefulArea = `${genericAreas[0]} m²`;
        if (!totalArea && genericAreas[1]) totalArea = `${genericAreas[1]} m²`;
    }

    const maintenanceMatch = body.match(/gastos?\s+comunes?[^\d]{0,20}([\d.\s,]+(?:UF|CLP)?)/i);
    const maintenanceFee = maintenanceMatch ? cleanText(maintenanceMatch[1]) : null;

    return {
        bedrooms: bedrooms ? Number(bedrooms) : null,
        bathrooms: bathrooms ? Number(bathrooms) : null,
        parking: parking ? Number(parking) : null,
        storage: storage ? Number(storage) : null,
        useful_area: usefulArea,
        total_area: totalArea,
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

const extractOverviewItems = ($, pageNumber) => {
    const seen = new Set();
    const output = [];
    const cards = $('li.ui-search-layout__item, .ui-search-result__wrapper, .poly-card');

    cards.each((_, cardEl) => {
        const card = $(cardEl);
        const href = card.find('a[href*="MLC-"]').first().attr('href');
        const url = normalizeListingUrl(href);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const title =
            cleanText(card.find('h2,h3,.poly-component__title,.ui-search-item__title').first().text()) ||
            null;
        const location =
            cleanText(card.find('.poly-component__location,.poly-component__subtitle,[class*="location"],[class*="address"]').first().text()) ||
            null;
        const thumbnail =
            card.find('img').first().attr('src') ||
            card.find('img').first().attr('data-src') ||
            null;
        const priceText = cleanText(card.find('.andes-money-amount,[class*="price"]').first().text());
        const attributesText = cleanText(card.find('.poly-attributes-list,.ui-search-card-attributes').first().text());
        const summary = parseSummaryByRegex(`${attributesText} ${title || ''}`);

        output.push({
            source: 'overview',
            page: pageNumber,
            id: extractListingId(url),
            url,
            propertyTitle: title,
            location,
            thumbnail,
            ...parsePrice(priceText),
            ...summary,
        });
    });

    if (output.length > 0) return output;

    // Fallback for layouts where cards are not easily identifiable.
    return extractListingUrlsFromSearch($).map((listingUrl) => ({
        source: 'overview',
        page: pageNumber,
        id: extractListingId(listingUrl),
        url: listingUrl,
        propertyTitle: null,
        location: null,
        thumbnail: null,
        rawPrice: null,
        price: null,
        currency: null,
        bedrooms: null,
        bathrooms: null,
        parking: null,
    }));
};

const enrichOverviewFromEmbeddedState = ($, item) => {
    const id = item.id;
    if (!id) return item;
    const html = $.html();
    const compactId = id.replace('-', '');
    const marker = `"id":"${compactId}"`;
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) return item;

    const chunk = html.slice(markerIndex, markerIndex + 7000);
    const titleMatch = chunk.match(/"type":"title","id":"title","title":\{"text":"(.*?)"/);
    const locationMatch = chunk.match(/"type":"location","id":"location","location":\{"text":"(.*?)"/);
    const priceMatch = chunk.match(/"current_price":\{"value":([\d.]+),"currency":"([^"]+)"/);
    const attrsMatch = chunk.match(/"attributes_list":\{"separator":"[^"]*","texts":\[(.*?)\]\}/);

    let attributesText = '';
    if (attrsMatch?.[1]) {
        const attrValues = [...attrsMatch[1].matchAll(/"(.*?)"/g)].map((m) => decodeJsonEscapedText(m[1]));
        attributesText = cleanText(attrValues.join(' | '));
    }

    const title = cleanText(decodeJsonEscapedText(titleMatch?.[1])) || item.propertyTitle;
    const location = cleanText(decodeJsonEscapedText(locationMatch?.[1])) || item.location;
    const parsedByAttributes = parseSummaryByRegex(attributesText);

    let rawPrice = item.rawPrice;
    let price = item.price;
    let currency = item.currency;
    if (priceMatch) {
        const numericValue = Number(priceMatch[1]);
        const normalizedCurrency = currencyFromPortalCode(priceMatch[2]);
        rawPrice = normalizedCurrency ? `${numericValue} ${normalizedCurrency}` : String(numericValue);
        price = numericValue;
        currency = normalizedCurrency;
    }

    return {
        ...item,
        propertyTitle: title || null,
        location: location || null,
        rawPrice: rawPrice || null,
        price: price ?? null,
        currency: currency || null,
        bedrooms: parsedByAttributes.bedrooms ?? item.bedrooms ?? null,
        bathrooms: parsedByAttributes.bathrooms ?? item.bathrooms ?? null,
        parking: parsedByAttributes.parking ?? item.parking ?? null,
        useful_area: parsedByAttributes.useful_area ?? item.useful_area ?? null,
        total_area: parsedByAttributes.total_area ?? item.total_area ?? null,
    };
};

const buildSearchUrl = ({ operation, propertyType, location, condition, modality, searchUrl }) => {
    if (searchUrl) return searchUrl;
    const selectedCondition = modality && modality !== 'any' ? modality : condition;
    const segments = [operation || 'venta', propertyType || 'departamento'];
    if (selectedCondition && selectedCondition !== 'any') segments.push(selectedCondition);
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
    modality = 'any',
    searchUrl,
    listingUrls = [],
    maxResults,
    maxPages,
    proxyConfiguration,
} = input;

const maxResultsLimit = parsePositiveIntWithDefault(maxResults, 5);
const maxPagesLimit = parsePositiveIntWithDefault(maxPages, 5);
const filters = buildFilters(input);

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
    const initialSearchUrl = buildSearchUrl({
        operation,
        propertyType,
        location,
        condition,
        modality,
        searchUrl,
    });
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
        if (outputCount >= maxResultsLimit) return;

        if (request.userData.label === 'SEARCH') {
            const pageNumber = request.userData.page || 1;
            const overviews = extractOverviewItems($, pageNumber);
            crawlerLog.info(`Search page ${pageNumber}: found ${overviews.length} listing cards.`);

            let addedFromPage = 0;
            for (const rawOverview of overviews) {
                if (outputCount >= maxResultsLimit) break;
                const overview = enrichOverviewFromEmbeddedState($, rawOverview);
                const listingUrl = overview.url;
                if (seenListingUrls.has(listingUrl)) continue;
                seenListingUrls.add(listingUrl);

                if (scrapeMode === 'overview') {
                    if (!matchesFilters(overview, filters)) continue;
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
                pageNumber < maxPagesLimit &&
                outputCount < maxResultsLimit &&
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
            if (!matchesFilters(detail, filters)) {
                crawlerLog.info(`Filtered out: ${detail.id || detail.url}`);
                return;
            }
            await Actor.pushData(detail);
            outputCount += 1;
            crawlerLog.info(`Saved detail ${outputCount}/${maxResultsLimit}: ${detail.id || detail.url}`);
        }
    },
    failedRequestHandler({ request }) {
        log.error(`Request failed after retries: ${request.url}`);
    },
});

await crawler.run();
await Actor.exit();
