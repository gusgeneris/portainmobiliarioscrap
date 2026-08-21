import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, log } from 'crawlee';
import { readFile } from 'node:fs/promises';

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

const normalizeBrokerName = (value) => {
    const base = cleanText(String(value || ''))
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' y ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return base || null;
};

const toCompactBrokerName = (normalizedName) => {
    if (!normalizedName) return null;
    const stopwords = new Set([
        'propiedades',
        'propiedad',
        'inmobiliaria',
        'inmobiliario',
        'gestion',
        'consultas',
        'brokers',
        'broker',
        'spa',
        'ltda',
        'limitada',
        'asesores',
        'asociados',
    ]);
    const compact = normalizedName
        .split(' ')
        .filter((token) => token && !stopwords.has(token))
        .join(' ')
        .trim();
    return compact || normalizedName;
};

const parseCsvRows = (csvText) => {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i += 1) {
        const char = csvText[i];
        const next = csvText[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                field += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            row.push(field);
            field = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') i += 1;
            row.push(field);
            field = '';
            if (row.some((cell) => cleanText(cell).length > 0)) rows.push(row);
            row = [];
            continue;
        }

        field += char;
    }

    row.push(field);
    if (row.some((cell) => cleanText(cell).length > 0)) rows.push(row);
    return rows;
};

const buildBrokerContactsLookup = (rows) => {
    const exact = new Map();
    const compact = new Map();
    let loadedCount = 0;
    let validPhoneCount = 0;

    for (const row of rows) {
        const brokerRaw = normalizeNullableString(row?.[0]);
        const phoneRaw = normalizeNullableString(row?.[1]);

        if (!brokerRaw) continue;
        if (/^corredora$/i.test(brokerRaw)) continue;

        loadedCount += 1;
        const normalized = normalizeBrokerName(brokerRaw);
        if (!normalized) continue;
        const compactName = toCompactBrokerName(normalized);
        const phone = normalizePhone(phoneRaw);

        if (!phone) continue;
        validPhoneCount += 1;

        const entry = {
            brokerName: brokerRaw,
            normalizedName: normalized,
            compactName,
            phone,
        };

        if (!exact.has(normalized)) exact.set(normalized, entry);
        if (compactName && !compact.has(compactName)) compact.set(compactName, entry);
    }

    return { exact, compact, loadedCount, validPhoneCount };
};

const loadBrokerContactsLookup = async (csvPath) => {
    if (!csvPath) return null;
    try {
        const raw = await readFile(csvPath, 'utf8');
        const rows = parseCsvRows(raw);
        const lookup = buildBrokerContactsLookup(rows);
        log.info(
            `Broker contacts CSV loaded (${csvPath}): ${lookup.validPhoneCount} usable phones ` +
                `from ${lookup.loadedCount} broker rows.`,
        );
        return lookup;
    } catch (error) {
        log.warning(`Could not load broker contacts CSV (${csvPath}): ${error.message}`);
        return null;
    }
};

const findBrokerContact = (sellerName, lookup) => {
    if (!lookup || !sellerName) return null;
    const normalizedSeller = normalizeBrokerName(sellerName);
    if (!normalizedSeller) return null;

    const compactSeller = toCompactBrokerName(normalizedSeller);
    const directExact = lookup.exact.get(normalizedSeller);
    if (directExact) return { ...directExact, matchType: 'exact' };

    if (compactSeller) {
        const directCompact = lookup.compact.get(compactSeller);
        if (directCompact) return { ...directCompact, matchType: 'compact' };
    }

    if (compactSeller) {
        let best = null;
        for (const entry of lookup.compact.values()) {
            const candidate = entry.compactName;
            if (!candidate) continue;
            if (
                compactSeller === candidate ||
                compactSeller.includes(candidate) ||
                candidate.includes(compactSeller)
            ) {
                if (!best || candidate.length > best.compactName.length) best = entry;
            }
        }
        if (best) return { ...best, matchType: 'contains' };
    }

    return null;
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

const dismissCookieBanner = async (page) => {
    const selectors = [
        '#newCookieDisclaimerButton',
        'button:has-text("Entendido")',
        '[class*="cookie" i] button',
        '[id*="cookie" i] button',
    ];
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const isVisible = await locator.isVisible().catch(() => false);
        if (isVisible) {
            await locator.click({ timeout: 1500 }).catch(() => null);
            return true;
        }
    }
    return false;
};

// Apify's default proxy pool (no groups specified) is datacenter, which reCAPTCHA Enterprise
// scores very poorly against, essentially guaranteeing a visible challenge on every attempt.
// Browser-based contact resolution needs residential IPs to have a realistic success rate.
const buildBrowserProxyConfiguration = async (rawProxyConfiguration) => {
    if (rawProxyConfiguration) {
        return Actor.createProxyConfiguration(rawProxyConfiguration);
    }
    try {
        const residentialProxy = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
            countryCode: 'CL',
        });
        log.info('Browser mode: using RESIDENTIAL proxy group (countryCode=CL) to reduce recaptcha challenges.');
        return residentialProxy;
    } catch (err) {
        log.warning(
            `Browser mode: could not enable RESIDENTIAL proxy (${err.message}). Falling back to the default ` +
                'datacenter pool, which is much more likely to trigger recaptcha challenges on every listing. ' +
                'Provide "proxyConfiguration" with residential access to fix this.',
        );
        return Actor.createProxyConfiguration();
    }
};

const hasRecaptchaChallenge = async (page) => {
    const count = await page
        .locator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]')
        .count()
        .catch(() => 0);
    return count > 0;
};

const DAILY_LIMIT_MESSAGE_HINTS = ['límite de contactos diarios', 'limite de contactos diarios', 'vuelve a intentarlo mañana'];

const isDailyLimitMessage = (message) => {
    if (!message) return false;
    const normalized = message.toLowerCase();
    return DAILY_LIMIT_MESSAGE_HINTS.some((hint) => normalized.includes(hint));
};

const CONTACT_FAILURE_REASONS = {
    MISSING_ITEM_ID: 'missing_item_id',
    WHATSAPP_BUTTON_NOT_FOUND: 'whatsapp_button_not_found',
    API_RESPONSE_TIMEOUT: 'api_response_timeout',
    RECAPTCHA_CHALLENGE: 'recaptcha_challenge',
    DAILY_LIMIT_REACHED: 'daily_limit_reached',
    API_HTTP_ERROR: 'api_http_error',
    API_REJECTED: 'api_rejected',
    MISSING_WHATSAPP_TARGET: 'missing_whatsapp_target',
    INVALID_API_PAYLOAD: 'invalid_api_payload',
};

const emptyContactResult = (extra = {}) => ({
    target: null,
    phone: null,
    recaptchaChallenge: false,
    dailyLimitReached: false,
    displayMessage: null,
    failureReason: null,
    httpStatus: null,
    selectorUsed: null,
    clickAttempts: 0,
    ...extra,
});

const formatContactExtractionLog = (realContact) => {
    const parts = [realContact?.failureReason || 'unknown'];
    if (realContact?.displayMessage) parts.push(`message="${realContact.displayMessage}"`);
    if (realContact?.httpStatus != null) parts.push(`http=${realContact.httpStatus}`);
    if (realContact?.selectorUsed) parts.push(`selector="${realContact.selectorUsed}"`);
    if (realContact?.clickAttempts) parts.push(`clickAttempts=${realContact.clickAttempts}`);
    if (realContact?.recaptchaChallenge) parts.push('recaptcha=true');
    return parts.join(', ');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Navigation only waits for `domcontentloaded` (for speed), but the WhatsApp button's click
// handler is attached by React after hydration, which can lag behind that event. A single
// immediate `force: true` click frequently fires before hydration completes and silently does
// nothing (no request, no error). Retrying a few times with short gaps reliably catches the
// window once the page becomes interactive, without materially increasing runtime on the happy path.
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));

const clickWhatsAppButtonAndWaitForApiResponse = async ({ page, locator, endpointFragment, maxAttempts = 3 }) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const responsePromise = page
            .waitForResponse(
                (response) => response.url().includes(endpointFragment) && response.request().method() === 'GET',
                { timeout: 2500 },
            )
            .catch(() => null);

        await locator.scrollIntoViewIfNeeded().catch(() => null);
        // A brief mouse hover + randomized pause before clicking mimics human interaction more
        // closely than an instant click, which risk engines like recaptcha enterprise weigh in.
        const box = await locator.boundingBox().catch(() => null);
        if (box) {
            await page
                .mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: randomBetween(5, 12) })
                .catch(() => null);
        }
        await sleep(randomBetween(150, 400));
        // First attempt uses Playwright's normal actionability wait (helps skip until the
        // element is actually interactive); later attempts force the click as a fallback.
        await locator.click({ timeout: attempt === 1 ? 2500 : 1200, force: attempt > 1 }).catch(() => null);

        const response = await responsePromise;
        if (response) return { response, attempts: attempt };

        if (attempt < maxAttempts) await sleep(500);
    }
    return { response: null, attempts: maxAttempts };
};

const extractRealWhatsAppFromApiResponse = async ({ page, itemId, maxClickAttempts = 3 }) => {
    if (!itemId) {
        return emptyContactResult({ failureReason: CONTACT_FAILURE_REASONS.MISSING_ITEM_ID });
    }
    const compactItemId = itemId.replace('-', '');
    const endpointFragment = `/p/api/items/${compactItemId}/contact-info/whatsapp`;
    // Prefer the exact button class from the real DOM over generic text/attribute matches.
    const selectors = [
        '.ui-vip-action-contact-info',
        'button:has-text("WhatsApp")',
        'a:has-text("WhatsApp")',
        '[data-testid*="whatsapp"]',
        '[aria-label*="WhatsApp" i]',
        '[class*="whatsapp"]',
    ];

    let selectedLocator = null;
    let selectorUsed = null;
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const isVisible = await locator.isVisible().catch(() => false);
        if (isVisible) {
            selectedLocator = locator;
            selectorUsed = selector;
            break;
        }
    }

    if (!selectedLocator) {
        return emptyContactResult({
            failureReason: CONTACT_FAILURE_REASONS.WHATSAPP_BUTTON_NOT_FOUND,
        });
    }

    // Give the page a short grace period to finish hydrating (script execution/`load`) before the
    // first click attempt; navigation only waited for `domcontentloaded`, which fires before React
    // attaches its event handlers on heavier pages.
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => null);

    const { response, attempts } = await clickWhatsAppButtonAndWaitForApiResponse({
        page,
        locator: selectedLocator,
        endpointFragment,
        maxAttempts: maxClickAttempts,
    });

    if (!response) {
        const recaptchaChallenge = await hasRecaptchaChallenge(page);
        return emptyContactResult({
            selectorUsed,
            recaptchaChallenge,
            clickAttempts: attempts,
            failureReason: recaptchaChallenge
                ? CONTACT_FAILURE_REASONS.RECAPTCHA_CHALLENGE
                : CONTACT_FAILURE_REASONS.API_RESPONSE_TIMEOUT,
        });
    }

    // The endpoint returns HTTP 200 even for business-rule failures (e.g. daily quota),
    // so the JSON payload's `success`/`display_message` fields are the real signal.
    const httpStatus = response.status();
    const payload = await response.json().catch(() => null);
    const displayMessage = typeof payload?.display_message === 'string' ? payload.display_message : null;
    const dailyLimitReached = payload?.success === false && isDailyLimitMessage(displayMessage);

    if (payload == null) {
        return emptyContactResult({
            selectorUsed,
            httpStatus,
            clickAttempts: attempts,
            failureReason: CONTACT_FAILURE_REASONS.INVALID_API_PAYLOAD,
        });
    }

    if (dailyLimitReached) {
        return emptyContactResult({
            selectorUsed,
            httpStatus,
            clickAttempts: attempts,
            dailyLimitReached: true,
            displayMessage,
            failureReason: CONTACT_FAILURE_REASONS.DAILY_LIMIT_REACHED,
        });
    }

    if (!response.ok() || payload?.success === false) {
        const recaptchaChallenge = await hasRecaptchaChallenge(page);
        return emptyContactResult({
            selectorUsed,
            httpStatus,
            clickAttempts: attempts,
            recaptchaChallenge,
            displayMessage,
            failureReason: recaptchaChallenge
                ? CONTACT_FAILURE_REASONS.RECAPTCHA_CHALLENGE
                : !response.ok()
                  ? CONTACT_FAILURE_REASONS.API_HTTP_ERROR
                  : CONTACT_FAILURE_REASONS.API_REJECTED,
        });
    }

    const target = normalizeContactLink(payload?.whatsapp?.target);
    if (!target) {
        return emptyContactResult({
            selectorUsed,
            httpStatus,
            clickAttempts: attempts,
            displayMessage,
            failureReason: CONTACT_FAILURE_REASONS.MISSING_WHATSAPP_TARGET,
        });
    }

    return {
        target,
        phone: extractPhoneFromWhatsAppLink(target),
        recaptchaChallenge: false,
        dailyLimitReached: false,
        displayMessage,
        failureReason: null,
        httpStatus,
        selectorUsed,
        clickAttempts: attempts,
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
    // Contact data is scarce (recaptcha/daily-limit blocked) and shouldn't hard-block results by
    // default; leave it opt-in so runs don't silently return empty.
    requireContactData: parseBoolean(input.requireContactData, false),
    publishedSince: normalizeChoice(input.publishedSince, ['any', 'today', 'last_week'], 'last_week'),
    trustPortalPriceRange: parseBoolean(input.trustPortalPriceRange, true),
});

const UF_INDICATOR_URL = 'https://mindicador.cl/api/uf';

const fetchUfToClpRate = async () => {
    try {
        const response = await fetch(UF_INDICATOR_URL, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return null;
        const data = await response.json();
        const rawValue = data?.serie?.[0]?.valor ?? data?.valor;
        const rate = Number(rawValue);
        return Number.isFinite(rate) && rate > 0 ? rate : null;
    } catch {
        return null;
    }
};

const convertBetweenUfAndClp = (price, fromCurrency, toCurrency, ufToClpRate) => {
    if (price == null || ufToClpRate == null || ufToClpRate <= 0) return null;
    const from = (fromCurrency || '').toUpperCase();
    const to = (toCurrency || '').toUpperCase();
    if (!from || !to || from === to) return price;
    if (from === 'UF' && to === 'CLP') return price * ufToClpRate;
    if (from === 'CLP' && to === 'UF') return price / ufToClpRate;
    return null;
};

const withinRange = (value, min, max) => {
    if (min == null && max == null) return true;
    if (value == null) return false;
    if (min != null && value < min) return false;
    if (max != null && value > max) return false;
    return true;
};

const matchesPriceFilter = (item, filters) => {
    if (filters.minPrice == null && filters.maxPrice == null) return true;
    if (item.price == null) return false;

    const itemCurrency = (item.currency || '').toUpperCase();
    const filterCurrency = filters.priceCurrency || 'any';
    const sameOrUnknownCurrency =
        filterCurrency === 'any' || !itemCurrency || itemCurrency === filterCurrency;

    if (sameOrUnknownCurrency) {
        return withinRange(item.price, filters.minPrice, filters.maxPrice);
    }

    const convertedPrice = convertBetweenUfAndClp(
        item.price,
        itemCurrency,
        filterCurrency,
        filters.ufToClpRate,
    );
    if (convertedPrice == null) {
        // Portal already applied PriceRange_*; don't drop mixed-currency cards if FX is unavailable.
        return Boolean(filters.skipCurrencyValidation);
    }
    return withinRange(convertedPrice, filters.minPrice, filters.maxPrice);
};

// The site does not expose a "last week" search facet nor a publish date on search-result
// cards, so this can only be verified once a detail page has been visited (see
// extractPublishedRecency). When the bucket is "unknown" (overview mode, or the badge wasn't
// found) we let the item through rather than silently dropping everything.
const matchesPublishedSince = (item, publishedSince) => {
    if (!publishedSince || publishedSince === 'any') return true;
    const bucket = item.publishedRecencyBucket || 'unknown';
    if (bucket === 'unknown') return true;
    if (publishedSince === 'today') return bucket === 'today';
    return bucket === 'today' || bucket === 'this_week';
};

const matchesFilters = (item, filters) => {
    if (!matchesPriceFilter(item, filters)) return false;

    return (
        withinRange(item.bedrooms, filters.minBedrooms, filters.maxBedrooms) &&
        withinRange(item.bathrooms, filters.minBathrooms, filters.maxBathrooms) &&
        withinRange(item.parking, filters.minParking, filters.maxParking) &&
        (!filters.withParking || (item.parking != null && item.parking > 0)) &&
        (!filters.requireContactData || Boolean(item.contactPhone) || (Array.isArray(item.contactLinks) && item.contactLinks.length > 0)) &&
        matchesPublishedSince(item, filters.publishedSince)
    );
};

// Parses the human-readable recency badge the site actually renders on detail pages (e.g.
// "Publicado hoy", "Publicado esta semana", "Publicado hace 2 meses") into a comparable bucket.
// There is no structured publish-date field anywhere in the HTML/JSON payloads, so this text is
// the only real signal available for "published in the last week".
const parsePublishedRecency = (rawText) => {
    const text = cleanText(rawText).toLowerCase();
    if (!text) return { bucket: 'unknown', daysAgo: null, rawText: null };

    if (/\bhoy\b/.test(text)) return { bucket: 'today', daysAgo: 0, rawText: text };
    if (/\bayer\b/.test(text)) return { bucket: 'this_week', daysAgo: 1, rawText: text };
    if (/esta\s+semana/.test(text)) return { bucket: 'this_week', daysAgo: null, rawText: text };

    const daysMatch = text.match(/hace\s+(\d+)\s*d[ií]as?/);
    if (daysMatch) {
        const days = Number(daysMatch[1]);
        return { bucket: days <= 0 ? 'today' : days <= 7 ? 'this_week' : 'older', daysAgo: days, rawText: text };
    }

    const weeksMatch = text.match(/hace\s+(\d+)\s*semanas?/);
    if (weeksMatch) {
        const weeks = Number(weeksMatch[1]);
        return { bucket: weeks <= 1 ? 'this_week' : 'older', daysAgo: weeks * 7, rawText: text };
    }

    if (/hace\s+m[aá]s\s+de\s+un\s+a[ñn]o/.test(text)) {
        return { bucket: 'older', daysAgo: 366, rawText: text };
    }

    const monthsMatch = text.match(/hace\s+(\d+)\s*mes(?:es)?/);
    if (monthsMatch) return { bucket: 'older', daysAgo: Number(monthsMatch[1]) * 30, rawText: text };

    const yearsMatch = text.match(/hace\s+(\d+)\s*a[ñn]os?/);
    if (yearsMatch) return { bucket: 'older', daysAgo: Number(yearsMatch[1]) * 365, rawText: text };

    return { bucket: 'unknown', daysAgo: null, rawText: text };
};

// The recency badge lives in the page subtitle as "{headline}  |  Publicado {texto}". Prefer
// that structured split; fall back to a full-body regex (excluding "Publicado por {seller}",
// which is an unrelated byline) for layout variants where the subtitle selector doesn't match.
const extractPublishedRecencyText = ($) => {
    const badge = cleanText($('[class*="subtitle_rex"], .ui-pdp-subtitle_rex').first().text());
    if (badge) {
        const publishedPart = badge
            .split('|')
            .map((part) => cleanText(part))
            .find((part) => /^publicad[oa]\b/i.test(part));
        if (publishedPart) return publishedPart.replace(/^publicad[oa]\s+/i, '');
    }

    // cheerio's .text() concatenates <script> contents too, so exclude quote/brace characters
    // that would otherwise let this regex match leftover JSON instead of real page text.
    const bodyText = cleanText($('body').text());
    const match = bodyText.match(/Publicad[oa]\s+(?!por\b)([^|<."{}]{1,40})/i);
    return match ? cleanText(match[1]) : null;
};

const extractSellerName = ($) => {
    const fromProfileLink = cleanText($('a[href="#seller_profile"]').first().text());
    if (fromProfileLink) return fromProfileLink;

    const html = $.html();
    const scriptMatch = html.match(/Publicado por \{action\}[\s\S]{0,600}?"label":\{"text":"([^"]{2,80})"/i);
    if (scriptMatch?.[1]) return cleanText(decodeJsonEscapedText(scriptMatch[1]));

    const bodyText = cleanText($('body').text());
    const fallbackTextMatch = bodyText.match(/Publicado por\s+([^\|<."{}]{2,80})/i);
    return fallbackTextMatch ? cleanText(fallbackTextMatch[1]) : null;
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
            // Publish date is never present on search-result cards; only detail pages expose it.
            publishedRecencyText: null,
            publishedRecencyBucket: 'unknown',
            publishedRecencyDaysAgo: null,
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
        publishedRecencyText: null,
        publishedRecencyBucket: 'unknown',
        publishedRecencyDaysAgo: null,
    }));
};

const enrichOverviewFromEmbeddedState = ($, item, brokerContactsLookup = null) => {
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
    const sellerMatch = chunk.match(/"type":"seller","id":"seller","seller":\{"text":"(.*?)"/);

    let attributesText = '';
    if (attrsMatch?.[1]) {
        const attrValues = [...attrsMatch[1].matchAll(/"(.*?)"/g)].map((m) => decodeJsonEscapedText(m[1]));
        attributesText = cleanText(attrValues.join(' | '));
    }

    const title = cleanText(decodeJsonEscapedText(titleMatch?.[1])) || item.propertyTitle;
    const location = cleanText(decodeJsonEscapedText(locationMatch?.[1])) || item.location;
    const sellerName = cleanText(decodeJsonEscapedText(sellerMatch?.[1])) || item.sellerName || null;
    const parsedByAttributes = parseSummaryByRegex(attributesText);
    const csvBrokerContact = findBrokerContact(sellerName, brokerContactsLookup);
    const mergedPhonesWithCsv = csvBrokerContact?.phone
        ? [...new Set([...(item.contactPhones || []), csvBrokerContact.phone])]
        : item.contactPhones || [];

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
        sellerName,
        rawPrice: rawPrice || null,
        price: price ?? null,
        currency: currency || null,
        bedrooms: parsedByAttributes.bedrooms ?? item.bedrooms ?? null,
        bathrooms: parsedByAttributes.bathrooms ?? item.bathrooms ?? null,
        parking: parsedByAttributes.parking ?? item.parking ?? null,
        useful_area: parsedByAttributes.useful_area ?? item.useful_area ?? null,
        total_area: parsedByAttributes.total_area ?? item.total_area ?? null,
        contactPhone: mergedPhonesWithCsv[0] || item.contactPhone || null,
        contactPhones: mergedPhonesWithCsv,
        contactAvailability:
            mergedPhonesWithCsv.length > 0 ? 'phone_visible' : item.contactAvailability || 'unknown',
        contactSource:
            mergedPhonesWithCsv.length > 0
                ? csvBrokerContact?.phone
                    ? 'csv'
                    : item.contactSource || 'portal'
                : item.contactSource || 'none',
        contactMatchedBroker: csvBrokerContact?.brokerName || item.contactMatchedBroker || null,
        contactMatchType: csvBrokerContact?.matchType || item.contactMatchType || null,
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

const toPortalPriceCurrency = (priceCurrency) => {
    if (priceCurrency === 'UF') return 'CLF';
    if (priceCurrency === 'CLP') return 'CLP';
    return null;
};

const buildPortalPriceRangeToken = ({ priceCurrency, minPrice, maxPrice }) => {
    const portalCurrency = toPortalPriceCurrency(priceCurrency);
    if (!portalCurrency) return null;
    if (maxPrice == null) return null;

    const normalizedMin = minPrice == null ? 0 : Math.max(0, Math.floor(minPrice));
    const normalizedMax = Math.max(0, Math.floor(maxPrice));
    if (normalizedMax < normalizedMin) return null;

    return `PriceRange_${normalizedMin}${portalCurrency}-${normalizedMax}${portalCurrency}`;
};

const applyRecentOrderSort = (url) => {
    if (!url) return url;
    const normalized = decodeHtmlEntities(url);
    try {
        const parsed = new URL(normalized);
        const path = parsed.pathname.replace(/\/$/, '');
        parsed.pathname = /_OrderId_[^/]+_NoIndex_True/i.test(path)
            ? path.replace(/_OrderId_[^/]+_NoIndex_True/i, '_OrderId_BEGINS*DESC_NoIndex_True')
            : `${path}/_OrderId_BEGINS*DESC_NoIndex_True`;
        return parsed.toString();
    } catch {
        return /_OrderId_[^/_]+_NoIndex_True/i.test(normalized)
            ? normalized.replace(/_OrderId_[^/_]+_NoIndex_True/i, '_OrderId_BEGINS*DESC_NoIndex_True')
            : `${normalized.replace(/\/$/, '')}/_OrderId_BEGINS*DESC_NoIndex_True`;
    }
};

const applyPriceRangeFilter = (url, filters) => {
    if (!url) return url;
    const priceRangeToken = buildPortalPriceRangeToken(filters || {});
    if (!priceRangeToken) return url;

    const injectToken = (pathValue) => {
        const cleanPath = pathValue.replace(/\/$/, '');
        const withoutExistingPriceRange = cleanPath
            .replace(/_PriceRange_[^/]+?(?=_NoIndex_True)/i, '')
            .replace(/_PriceRange_[^/]+$/i, '');

        if (/_NoIndex_True$/i.test(withoutExistingPriceRange)) {
            return withoutExistingPriceRange.replace(/_NoIndex_True$/i, `_${priceRangeToken}_NoIndex_True`);
        }
        return `${withoutExistingPriceRange}/_${priceRangeToken}_NoIndex_True`;
    };

    try {
        const parsed = new URL(decodeHtmlEntities(url));
        parsed.pathname = injectToken(parsed.pathname);
        return parsed.toString();
    } catch {
        return injectToken(decodeHtmlEntities(url));
    }
};

// The search UI only offers a real "Publicados hoy" facet, applied as the path segment
// `_PublishedToday_YES` (verified from the site's own facet payload). There is no `since`
// query parameter and no "last week" facet at all — the previous implementation set
// `?since=last_week`, which the site silently ignores, so it never actually filtered anything.
// For `last_week` we can't narrow the search itself; instead we rely on a post-filter using the
// real publish-recency badge from each detail page (see extractPublishedRecency).
const applyPublishedSinceFilter = (url, publishedSince) => {
    if (!url || publishedSince !== 'today') return url;
    try {
        const parsed = new URL(decodeHtmlEntities(url));
        if (!/_PublishedToday_YES\/?$/i.test(parsed.pathname)) {
            parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/_PublishedToday_YES`;
        }
        return parsed.toString();
    } catch {
        return url;
    }
};

// Filter path segments chain onto the URL (e.g. `.../_PublishedToday_YES`) but pagination needs
// its own segment starting with a slash. The previous version glued `_Desde_N_NoIndex_True`
// directly onto the previous segment with no separator, producing a URL the site didn't
// recognize (breaking pagination past page 1 whenever any other filter segment was present).
const buildNextPageUrl = (currentUrl, pageNumber) => {
    const offset = (pageNumber - 1) * RESULTS_PER_PAGE + 1;
    const url = decodeHtmlEntities(currentUrl).replace(/\/$/, '');
    const withoutPreviousOffset = url
        .replace(/\/_Desde_\d+_NoIndex_True$/i, '')
        .replace(/_NoIndex_True$/i, '');
    return `${withoutPreviousOffset}/_Desde_${offset}_NoIndex_True`;
};

const extractDetail = ($, request, overview, brokerContactsLookup) => {
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
    const sellerName = extractSellerName($);
    const csvBrokerContact = findBrokerContact(sellerName, brokerContactsLookup);
    const mergedPhonesWithCsv = csvBrokerContact?.phone
        ? [...new Set([...(allPhones || []), csvBrokerContact.phone])]
        : allPhones;
    const contactAvailability = detectContactAvailability($, mergedPhonesWithCsv, directContactLinks);
    const publishedRecencyRawText = extractPublishedRecencyText($);
    const publishedRecency = parsePublishedRecency(publishedRecencyRawText);
    const contactSource =
        mergedPhonesWithCsv.length > 0
            ? allPhones.length > 0
                ? 'portal'
                : csvBrokerContact?.phone
                  ? 'csv'
                  : 'portal'
            : directContactLinks.length > 0
              ? 'portal'
              : 'none';

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
        sellerName: sellerName || null,
        contactPhone: mergedPhonesWithCsv[0] || null,
        contactPhones: mergedPhonesWithCsv,
        contactLink: directContactLinks[0] || null,
        contactLinks: directContactLinks,
        contactAvailability,
        contactSource,
        contactMatchedBroker: csvBrokerContact?.brokerName || null,
        contactMatchType: csvBrokerContact?.matchType || null,
        publishedRecencyText: publishedRecencyRawText || null,
        publishedRecencyBucket: publishedRecency.bucket,
        publishedRecencyDaysAgo: publishedRecency.daysAgo,
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
    maxConsecutiveContactFailures,
    contactsCsvPath: rawContactsCsvPath = 'Contacto de Corredoras - Hoja 1.csv',
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
const maxConsecutiveContactFailuresLimit = parsePositiveIntWithDefault(maxConsecutiveContactFailures, 6);
const contactsCsvPath = normalizeNullableString(rawContactsCsvPath) || 'Contacto de Corredoras - Hoja 1.csv';
const brokerContactsLookup = await loadBrokerContactsLookup(contactsCsvPath);
const portalPriceRangeToken = buildPortalPriceRangeToken(filters);
filters.skipCurrencyValidation =
    filters.trustPortalPriceRange && searchMode === 'byPlace' && Boolean(portalPriceRangeToken);

const needsUfRate =
    (filters.minPrice != null || filters.maxPrice != null) &&
    (filters.priceCurrency === 'UF' || filters.priceCurrency === 'CLP');
filters.ufToClpRate = needsUfRate ? await fetchUfToClpRate() : null;

if (filters.ufToClpRate) {
    log.info(`UF rate for price conversion: ${filters.ufToClpRate} CLP.`);
} else if (needsUfRate) {
    log.warning(
        'Could not fetch UF rate from mindicador.cl; mixed UF/CLP prices will fall back to the portal PriceRange when available.',
    );
}

if (filters.skipCurrencyValidation) {
    log.info(
        `Portal PriceRange is active (${portalPriceRangeToken}). ` +
            'Mixed UF/CLP cards are converted to the filter currency before min/max comparison.',
    );
}

if (scrapeMode === 'overview' && publishedSince !== 'any') {
    log.warning(
        `publishedSince="${publishedSince}" cannot be strictly verified in scrapeMode="overview": ` +
            'the site only shows a recency badge on detail pages, not on search-result cards. ' +
            'Results are not guaranteed to be within that window; use scrapeMode="detail" to enforce it.',
    );
}

if (searchMode === 'bySearchUrl' && !normalizedSearchUrl) {
    throw new Error('searchUrl is required when searchMode is "bySearchUrl".');
}

if (searchMode === 'byListingUrl' && (!Array.isArray(listingUrls) || listingUrls.length === 0)) {
    throw new Error('listingUrls must contain at least one URL when searchMode is "byListingUrl".');
}

if (searchMode === 'byListingUrl' && scrapeMode === 'detail' && shouldResolveContactViaBrowser) {
    const proxy = await buildBrowserProxyConfiguration(proxyConfiguration);
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

    let consecutiveContactFailures = 0;
    let recaptchaFailureCount = 0;

    const browserCrawler = new PlaywrightCrawler({
        requestQueue,
        proxyConfiguration: proxy,
        maxRequestRetries: 0,
        minConcurrency: 1,
        maxConcurrency: browserConcurrencyLimit,
        // Keep cookies/session tied to each proxy IP across requests: a "returning visitor" with
        // consistent cookies scores better with recaptcha than a fresh anonymous session every time.
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: browserConcurrencyLimit },
        navigationTimeoutSecs: 20,
        // Contact extraction now retries the click up to 3x (with a load-state grace wait) to
        // survive hydration lag, so give the handler more headroom than the older single-shot flow.
        requestHandlerTimeoutSecs: 30,
        launchContext: {
            launchOptions: {
                // Removes the most well-known CDP-visible automation signal Chrome exposes by default.
                args: ['--disable-blink-features=AutomationControlled'],
            },
        },
        browserPoolOptions: {
            preLaunchHooks: [
                (_pageId, launchContext) => {
                    launchContext.launchOptions = {
                        ...launchContext.launchOptions,
                        locale: 'es-CL',
                        timezoneId: 'America/Santiago',
                    };
                },
            ],
        },
        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                gotoOptions.waitUntil = 'domcontentloaded';
                gotoOptions.timeout = 20000;
                // Best-effort mitigation of the most common headless/automation fingerprint checks.
                // This is unlikely to fully defeat reCAPTCHA Enterprise's risk scoring on its own,
                // but removes the "free" tells that make automated sessions trivially detectable.
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    Object.defineProperty(navigator, 'languages', { get: () => ['es-CL', 'es', 'en'] });
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                    window.chrome = window.chrome || { runtime: {} };
                }).catch(() => null);
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

            await dismissCookieBanner(page);
            // When contact data isn't required, don't spend the full 3-attempt retry budget
            // chasing a click that's likely to fail anyway (recaptcha/daily limit) — a single
            // best-effort attempt still catches the happy path without the extra ~5-6s of
            // retries/pauses on every listing that won't be discarded regardless.
            const realContact = await extractRealWhatsAppFromApiResponse({
                page,
                itemId,
                maxClickAttempts: filters.requireContactData ? 3 : 1,
            });
            const hasDirectContact = Boolean(realContact?.phone || realContact?.target);

            // The site returns HTTP 200 with success:false + a "daily contact limit" message once the
            // account/session/IP quota for revealing contact info is exhausted. Once seen, every further
            // attempt will fail the same way until the quota resets, so stop the whole run immediately.
            if (realContact?.dailyLimitReached) {
                crawlerLog.warning(
                    `Daily WhatsApp contact-reveal limit reached (${formatContactExtractionLog(realContact)}). ` +
                        `Stopping browser crawler early: ${itemId || request.url}`,
                );
                await browserCrawler.stop('Daily contact-reveal limit reached on portalinmobiliario.com.');
                return;
            }

            // Fail-fast: skip full detail parsing when contact is required but unavailable,
            // this is the dominant cost driver when most listings don't yield a direct contact.
            if (filters.requireContactData && !hasDirectContact) {
                consecutiveContactFailures += 1;
                if (realContact?.recaptchaChallenge) recaptchaFailureCount += 1;
                crawlerLog.info(
                    `Filtered out (WhatsApp not extracted: ${formatContactExtractionLog(realContact)}): ${itemId || request.url}`,
                );

                if (consecutiveContactFailures >= maxConsecutiveContactFailuresLimit) {
                    crawlerLog.warning(
                        `Stopping browser crawler after ${consecutiveContactFailures} consecutive contact failures` +
                            `${recaptchaFailureCount > 0 ? ` (${recaptchaFailureCount} blocked by recaptcha)` : ''}.`,
                    );
                    await browserCrawler.stop('Too many consecutive contact failures.');
                }
                return;
            }

            consecutiveContactFailures = 0;

            const $ = await parseWithCheerio();
            const detail = extractDetail($, request, overview, brokerContactsLookup);

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
            if (realContact?.phone || realContact?.target) {
                detail.contactSource = 'portal';
            }

            if (!matchesFilters(detail, filters)) {
                crawlerLog.info(`Filtered out: ${detail.id || detail.url}`);
                return;
            }

            await Actor.pushData(detail);
            outputCount += 1;
            crawlerLog.info(`Saved detail ${outputCount}/${maxResultsLimit}: ${detail.id || detail.url}`);

            // All listingUrls are enqueued upfront, so without this the crawler keeps navigating
            // to (and paying the full page-load cost for) every remaining URL even after we
            // already have enough results — the early `outputCount >= maxResultsLimit` check up
            // top only skips the *processing*, not the navigation that already happened.
            if (outputCount >= maxResultsLimit) {
                crawlerLog.info(`Reached maxResults (${maxResultsLimit}); stopping browser crawler early.`);
                await browserCrawler.stop('Reached maxResults.');
            }
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
    const searchUrlOrderedByRecent = applyRecentOrderSort(baseSearchUrl);
    const searchUrlWithPriceRange = applyPriceRangeFilter(searchUrlOrderedByRecent, filters);
    const initialSearchUrl = applyPublishedSinceFilter(searchUrlWithPriceRange, publishedSince);
    log.info(
        `Search URL prepared (ordered by recent): ${initialSearchUrl} ` +
            `(publishedSince=${publishedSince}, searchMode=${searchMode}, priceCurrency=${filters.priceCurrency}, ` +
            `minPrice=${filters.minPrice ?? 'n/a'}, maxPrice=${filters.maxPrice ?? 'n/a'})`,
    );
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
                const overview = enrichOverviewFromEmbeddedState($, rawOverview, brokerContactsLookup);
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
            const detail = extractDetail($, request, request.userData.overview || {}, brokerContactsLookup);
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
