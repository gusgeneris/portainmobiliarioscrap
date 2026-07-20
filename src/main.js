import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, log } from 'crawlee';

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

const normalizePhone = (value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return null;
    const digits = cleaned.replace(/[^\d+]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    if (digits.startsWith('56')) return `+${digits}`;
    if (digits.length === 9) return `+56${digits}`;
    return digits;
};

const extractPhones = ($) => {
    const phones = new Set();

    $('a[href^="tel:"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const fromHref = normalizePhone(href.replace(/^tel:/i, ''));
        if (fromHref) phones.add(fromHref);
        const fromText = normalizePhone($(el).text());
        if (fromText) phones.add(fromText);
    });

    $('a[href*="wa.me/"], a[href*="whatsapp"]').each((_, el) => {
        const href = decodeHtmlEntities($(el).attr('href') || '');
        const waMatch = href.match(/wa\.me\/(\d{8,15})/i);
        if (waMatch?.[1]) phones.add(normalizePhone(waMatch[1]));
        const phoneParamMatch = href.match(/[?&]phone=(\d{8,15})/i);
        if (phoneParamMatch?.[1]) phones.add(normalizePhone(phoneParamMatch[1]));
    });

    const bodyText = cleanText($('body').text());
    const regexMatches = bodyText.match(/(\+?56\s?9\s?\d{4}\s?\d{4})/g) || [];
    for (const match of regexMatches) {
        const normalized = normalizePhone(match);
        if (normalized) phones.add(normalized);
    }

    return [...phones].filter(Boolean);
};

const extractContactLinks = ($) => {
    const links = new Set();
    $('a[href]').each((_, el) => {
        const href = ($(el).attr('href') || '').trim();
        if (!href) return;
        const lower = href.toLowerCase();
        if (lower.includes('wa.me/') || lower.includes('whatsapp') || lower.includes('contactar') || lower.includes('vis-modals')) {
            links.add(decodeHtmlEntities(href));
        }
    });

    // Parse escaped targets embedded in page state/scripts.
    const html = $.html();
    const targetMatches = [...html.matchAll(/"target":"(https:\\u002F\\u002F[^"]+)"/g)];
    for (const match of targetMatches) {
        const decoded = decodeJsonEscapedText(match[1]);
        const lower = decoded.toLowerCase();
        if (lower.includes('whatsapp') || lower.includes('wa.me/') || lower.includes('action=whatsapp')) {
            links.add(decoded);
        }
    }

    return [...links].filter(Boolean);
};

const buildDirectWhatsAppLink = (phone, listingUrl, title) => {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return null;
    const digits = normalizedPhone.replace(/[^\d]/g, '');
    if (!digits) return null;
    const encodedMessage = encodeURIComponent(`Hola, tengo algunas preguntas sobre ${title || 'esta propiedad'}. ${listingUrl || ''}`.trim());
    return `https://wa.me/${digits}?text=${encodedMessage}`;
};

const normalizeContactLink = (value) => {
    const normalized = decodeHtmlEntities(cleanText(value));
    if (!normalized) return null;
    if (normalized.startsWith('//')) return `https:${normalized}`;
    return normalized;
};

const isDirectWhatsAppLink = (link) => /wa\.me\/\d{8,15}/i.test(link || '') || /api\.whatsapp\.com\/send\?phone=\d{8,15}/i.test(link || '');

const extractPhoneFromWhatsAppLink = (link) => {
    const normalized = normalizeContactLink(link);
    if (!normalized) return null;
    const waMatch = normalized.match(/wa\.me\/(\d{8,15})/i);
    if (waMatch?.[1]) return normalizePhone(waMatch[1]);
    const phoneParamMatch = normalized.match(/[?&]phone=(\d{8,15})/i);
    if (phoneParamMatch?.[1]) return normalizePhone(phoneParamMatch[1]);
    return null;
};

const extractRealWhatsAppFromApiResponse = async ({ page, itemId }) => {
    if (!itemId) return null;
    const compactItemId = itemId.replace('-', '');
    const endpointFragment = `/p/api/items/${compactItemId}/contact-info/whatsapp`;
    const selectors = [
        'button:has-text("WhatsApp")',
        'a:has-text("WhatsApp")',
        '[data-testid*="whatsapp"]',
        '[aria-label*="WhatsApp" i]',
        '[class*="whatsapp"]',
    ];

    let selectedLocator = null;
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const isVisible = await locator.isVisible().catch(() => false);
        if (isVisible) {
            selectedLocator = locator;
            break;
        }
    }

    if (!selectedLocator) return null;

    const responsePromise = page
        .waitForResponse(
            (response) =>
                response.url().includes(endpointFragment) &&
                response.request().method() === 'GET',
            { timeout: 6000 },
        )
        .catch(() => null);

    await selectedLocator.click({ timeout: 2500, force: true }).catch(() => null);
    const response = await responsePromise;
    if (!response?.ok()) return null;

    const payload = await response.json().catch(() => null);
    const target = normalizeContactLink(payload?.whatsapp?.target);
    if (!target) return null;

    return {
        target,
        phone: extractPhoneFromWhatsAppLink(target),
    };
};

const calculateBrowserListingCap = (value, maxResultsLimit) => {
    const parsed = parseIntOrNull(value);
    if (parsed != null && parsed > 0) return parsed;
    // Default cap to avoid very long runs when many URLs are sent.
    return Math.max(maxResultsLimit * 2, maxResultsLimit);
};

const normalizeBrowserConcurrency = (value) => {
    const parsed = parseIntOrNull(value);
    if (parsed == null || parsed <= 0) return 1;
    return Math.min(parsed, 2);
};

const pickListingUrlsForBrowserMode = (urls, maxResultsLimit, browserListingCap) => {
    if (!Array.isArray(urls)) return [];
    const cap = Math.max(maxResultsLimit, browserListingCap);
    return urls.slice(0, cap);
};

const prioritizeContactLinks = ({ phones, contactLinks, listingUrl, title }) => {
    const prioritized = [];
    const seen = new Set();

    const pushUnique = (candidate) => {
        const normalized = normalizeContactLink(candidate);
        if (!normalized) return;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        prioritized.push(normalized);
    };

    // Prefer direct WhatsApp links with explicit phone number.
    for (const phone of phones || []) {
        pushUnique(buildDirectWhatsAppLink(phone, listingUrl, title));
    }

    const directLinks = (contactLinks || []).filter((link) => isDirectWhatsAppLink(link));
    const shareLinks = (contactLinks || []).filter((link) => !isDirectWhatsAppLink(link));
    for (const link of directLinks) pushUnique(link);
    for (const link of shareLinks) pushUnique(link);

    return prioritized;
};

const detectContactAvailability = ($, phones, contactLinks) => {
    const hasPhone = Array.isArray(phones) && phones.length > 0;
    if (hasPhone) return 'phone_visible';

    const hasContactLink = Array.isArray(contactLinks) && contactLinks.length > 0;
    if (hasContactLink) return 'whatsapp_visible';

    const bodyText = cleanText($('body').text()).toLowerCase();
    const hasContactFormHints =
        bodyText.includes('contactar') ||
        bodyText.includes('contáct') ||
        bodyText.includes('enviar mensaje') ||
        bodyText.includes('consulta');

    if (hasContactFormHints) return 'form_only';
    return 'not_visible';
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

const normalizeNullableString = (value) => {
    if (value == null) return null;
    const normalized = cleanText(String(value));
    if (!normalized) return null;
    if (['null', 'undefined', 'none', 'n/a', 'na'].includes(normalized.toLowerCase())) return null;
    return normalized;
};

const normalizeChoice = (value, allowedValues, fallback) => {
    const normalized = normalizeNullableString(value);
    if (!normalized) return fallback;
    if (allowedValues.includes(normalized)) return normalized;
    return fallback;
};

const parseBoolean = (value, defaultValue = false) => {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = cleanText(String(value)).toLowerCase();
    if (['true', '1', 'yes', 'si', 'sí'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
    return defaultValue;
};

const parseListingUrlsInput = (value) => {
    if (Array.isArray(value)) return value.map((entry) => normalizeNullableString(entry)).filter(Boolean);
    const normalized = normalizeNullableString(value);
    if (!normalized) return [];

    const parseAsJsonArray = (rawText) => {
        let current = rawText;
        for (let i = 0; i < 3; i += 1) {
            try {
                const parsed = JSON.parse(current);
                if (Array.isArray(parsed)) {
                    return parsed.map((entry) => normalizeNullableString(entry)).filter(Boolean);
                }
                if (typeof parsed === 'string') {
                    current = parsed;
                    continue;
                }
                return [];
            } catch {
                return [];
            }
        }
        return [];
    };

    const jsonCandidates = [
        normalized,
        decodeHtmlEntities(normalized),
        normalized.replace(/^"(.*)"$/s, '$1'),
        normalized.replace(/^"(.*)"$/s, '$1').replace(/\\\\+"/g, '"'),
    ];

    for (const candidate of jsonCandidates) {
        const parsed = parseAsJsonArray(candidate);
        if (parsed.length > 0) return parsed;
    }

    // Fallback for heavily escaped payloads from webhook middlewares.
    const regexUrls = [...normalized.matchAll(/https?:\/\/[^\s"'\\,\]]+/gi)].map((match) => match[0]);
    if (regexUrls.length > 0) {
        return regexUrls.map((entry) => normalizeNullableString(entry)).filter(Boolean);
    }

    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
            return parsed.map((entry) => normalizeNullableString(entry)).filter(Boolean);
        }
    } catch {
        // Continue with text parsing.
    }

    return normalized
        .split(/[\n,;]+/)
        .map((entry) => normalizeNullableString(entry))
        .filter(Boolean);
};

const normalizeInputCurrency = (value) => {
    const raw = cleanText(value).toUpperCase();
    if (!raw || raw === 'ANY') return 'any';
    if (raw === 'UF' || raw === 'CLF') return 'UF';
    if (raw === 'CLP' || raw === '$' || raw === 'PESOS' || raw === 'PESO') return 'CLP';
    return 'any';
};

const normalizeCurrencyFromAliases = (priceCurrency, currencyUnit) => {
    const byPriceCurrency = normalizeInputCurrency(priceCurrency);
    if (byPriceCurrency !== 'any') return byPriceCurrency;
    return normalizeInputCurrency(currencyUnit);
};

const buildFilters = (input) => ({
    priceCurrency: normalizeCurrencyFromAliases(input.priceCurrency, input.currencyUnit),
    minPrice: parseNumber(input.minPrice),
    maxPrice: parseNumber(input.maxPrice),
    minBedrooms: parseIntOrNull(input.minBedrooms),
    maxBedrooms: parseIntOrNull(input.maxBedrooms),
    minBathrooms: parseIntOrNull(input.minBathrooms),
    maxBathrooms: parseIntOrNull(input.maxBathrooms),
    minParking: parseIntOrNull(input.minParking),
    maxParking: parseIntOrNull(input.maxParking),
    withParking: parseBoolean(input.withParking, false),
    requireContactData: parseBoolean(input.requireContactData, true),
});

const withinRange = (value, min, max) => {
    if (min == null && max == null) return true;
    if (value == null) return false;
    if (min != null && value < min) return false;
    if (max != null && value > max) return false;
    return true;
};

const matchesFilters = (item, filters) => {
    const currencyMatches =
        filters.priceCurrency === 'any' ||
        (item.currency && item.currency.toUpperCase() === filters.priceCurrency);

    if (!currencyMatches) return false;

    return (
        withinRange(item.price, filters.minPrice, filters.maxPrice) &&
        withinRange(item.bedrooms, filters.minBedrooms, filters.maxBedrooms) &&
        withinRange(item.bathrooms, filters.minBathrooms, filters.maxBathrooms) &&
        withinRange(item.parking, filters.minParking, filters.maxParking) &&
        (!filters.withParking || (item.parking != null && item.parking > 0)) &&
        (!filters.requireContactData || Boolean(item.contactPhone) || (Array.isArray(item.contactLinks) && item.contactLinks.length > 0))
    );
};

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
            contactPhone: null,
            contactPhones: [],
            contactLink: null,
            contactLinks: [],
            contactAvailability: 'unknown',
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
        contactPhone: null,
        contactPhones: [],
        contactLink: null,
        contactLinks: [],
        contactAvailability: 'unknown',
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

const applyPublishedSinceFilter = (url, publishedSince) => {
    if (!url || !publishedSince || publishedSince === 'any') return url;
    try {
        const parsed = new URL(decodeHtmlEntities(url));
        // Respect an explicit `since` coming from searchUrl.
        if (!parsed.searchParams.has('since')) {
            parsed.searchParams.set('since', publishedSince);
        }
        return parsed.toString();
    } catch {
        return url;
    }
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
    const phones = extractPhones($);
    const rawContactLinks = extractContactLinks($);
    const contactLinks = prioritizeContactLinks({
        phones,
        contactLinks: rawContactLinks,
        listingUrl: request.loadedUrl || request.url,
        title: title || overview.propertyTitle,
    });
    const phonesFromLinks = (contactLinks || [])
        .map((link) => extractPhoneFromWhatsAppLink(link))
        .filter(Boolean);
    const allPhones = [...new Set([...(phones || []), ...phonesFromLinks])];
    // Keep only direct WhatsApp links with explicit phone numbers.
    const directContactLinks = [...new Set((contactLinks || []).filter((link) => isDirectWhatsAppLink(link)))];
    const contactAvailability = detectContactAvailability($, allPhones, directContactLinks);

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
        contactPhone: allPhones[0] || null,
        contactPhones: allPhones,
        contactLink: directContactLinks[0] || null,
        contactLinks: directContactLinks,
        contactAvailability,
    };
};

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    scrapeMode: rawScrapeMode,
    includeDetails,
    searchMode: rawSearchMode = 'byPlace',
    operation: rawOperation = 'venta',
    propertyType: rawPropertyType = 'departamento',
    location: rawLocation = 'santiago-metropolitana',
    condition: rawCondition = 'any',
    modality: rawModality = 'any',
    publishedSince: rawPublishedSince = 'last_week',
    searchUrl,
    listingUrls: rawListingUrls = [],
    maxResults,
    maxPages,
    proxyConfiguration,
    resolveContactViaBrowser,
    browserConcurrency,
    maxBrowserListings,
} = input;

const includeDetailsEnabled = parseBoolean(includeDetails, true);
const inferredScrapeMode = includeDetailsEnabled ? 'detail' : 'overview';
const scrapeMode = normalizeChoice(rawScrapeMode, ['overview', 'detail'], inferredScrapeMode);
const searchMode = normalizeChoice(rawSearchMode, ['byPlace', 'bySearchUrl', 'byListingUrl'], 'byPlace');
const operation = normalizeChoice(rawOperation, ['venta', 'arriendo', 'arriendo-temporal'], 'venta');
const propertyType = normalizeChoice(
    rawPropertyType,
    ['departamento', 'casa', 'oficina', 'terreno', 'parcela', 'local', 'bodega'],
    'departamento',
);
const location = normalizeNullableString(rawLocation) || 'santiago-metropolitana';
const condition = normalizeChoice(rawCondition, ['any', 'propiedades-usadas', 'propiedades-nuevas'], 'any');
const modality = normalizeChoice(rawModality, ['any', 'propiedades-usadas', 'propiedades-nuevas', 'proyectos'], 'any');
const publishedSince = normalizeChoice(rawPublishedSince, ['any', 'today', 'last_week'], 'last_week');
const listingUrls = parseListingUrlsInput(rawListingUrls);
const normalizedSearchUrl = normalizeNullableString(searchUrl);

const maxResultsLimit = parsePositiveIntWithDefault(maxResults, 5);
const maxPagesLimit = parsePositiveIntWithDefault(maxPages, 5);
const filters = buildFilters(input);
const shouldResolveContactViaBrowser = parseBoolean(resolveContactViaBrowser, false);
const browserConcurrencyLimit = normalizeBrowserConcurrency(browserConcurrency);
const browserListingCap = calculateBrowserListingCap(maxBrowserListings, maxResultsLimit);

if (searchMode === 'bySearchUrl' && !normalizedSearchUrl) {
    throw new Error('searchUrl is required when searchMode is "bySearchUrl".');
}

if (searchMode === 'byListingUrl' && (!Array.isArray(listingUrls) || listingUrls.length === 0)) {
    throw new Error('listingUrls must contain at least one URL when searchMode is "byListingUrl".');
}

if (searchMode === 'byListingUrl' && scrapeMode === 'detail' && shouldResolveContactViaBrowser) {
    const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
    const requestQueue = await Actor.openRequestQueue();
    const seenListingUrls = new Set();
    let outputCount = 0;
    const urlsForBrowser = pickListingUrlsForBrowserMode(listingUrls, maxResultsLimit, browserListingCap);

    if (listingUrls.length > urlsForBrowser.length) {
        log.warning(`Browser mode will process ${urlsForBrowser.length}/${listingUrls.length} listing URLs. Increase maxBrowserListings to scan more.`);
    }

    for (const rawUrl of urlsForBrowser) {
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

    const browserCrawler = new PlaywrightCrawler({
        requestQueue,
        proxyConfiguration: proxy,
        maxRequestRetries: 0,
        minConcurrency: 1,
        maxConcurrency: browserConcurrencyLimit,
        navigationTimeoutSecs: 20,
        requestHandlerTimeoutSecs: 30,
        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                gotoOptions.waitUntil = 'domcontentloaded';
                gotoOptions.timeout = 20000;
                await page.route('**/*', (route) => {
                    const resourceType = route.request().resourceType();
                    if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
                        return route.abort();
                    }
                    return route.continue();
                });
            },
        ],
        async requestHandler({ request, page, parseWithCheerio, log: crawlerLog }) {
            if (outputCount >= maxResultsLimit) return;
            const overview = request.userData.overview || {};
            const itemId = overview.id || extractListingId(request.loadedUrl || request.url);
            const realContact = await extractRealWhatsAppFromApiResponse({
                page,
                itemId,
            });

            const hasDirectContact = Boolean(realContact?.phone || realContact?.target);
            if (filters.requireContactData && !hasDirectContact) {
                crawlerLog.info(`Filtered out (no direct contact): ${itemId || request.url}`);
                return;
            }

            const $ = await parseWithCheerio();
            const detail = extractDetail($, request, overview);

            if (realContact?.phone) {
                const mergedPhones = [...new Set([realContact.phone, ...(detail.contactPhones || [])])];
                detail.contactPhone = mergedPhones[0] || null;
                detail.contactPhones = mergedPhones;
            }

            if (realContact?.target) {
                detail.contactLink = realContact.target;
                detail.contactLinks = [realContact.target];
            }

            detail.contactAvailability = detectContactAvailability($, detail.contactPhones, detail.contactLinks);

            if (!matchesFilters(detail, filters)) {
                crawlerLog.info(`Filtered out: ${detail.id || detail.url}`);
                return;
            }

            await Actor.pushData(detail);
            outputCount += 1;
            crawlerLog.info(`Saved detail ${outputCount}/${maxResultsLimit}: ${detail.id || detail.url}`);
        },
        failedRequestHandler({ request }) {
            log.error(`Request failed after retries: ${request.url}`);
        },
    });

    await browserCrawler.run();
    await Actor.exit();
    process.exit(0);
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
    const baseSearchUrl = buildSearchUrl({
        operation,
        propertyType,
        location,
        condition,
        modality,
        searchUrl: normalizedSearchUrl,
    });
    const initialSearchUrl = applyPublishedSinceFilter(baseSearchUrl, publishedSince);
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
