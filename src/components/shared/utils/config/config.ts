import {
    parseReferralLink,
    parseLandingParams,
    resolveReferralViaProxy,
} from '@/external/deriv-core';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import brandConfig from '../../../../../brand.config.json';

// =============================================================================
// Constants - Domain & Server Configuration (from brand.config.json)
// =============================================================================

// Production app domains
export const PRODUCTION_DOMAINS = {
    COM: brandConfig.platform.hostname.production.com,
} as const;

// Staging app domains
export const STAGING_DOMAINS = {
    COM: brandConfig.platform.hostname.staging.com,
} as const;

// WebSocket server URLs
export const WS_SERVERS = {
    STAGING: `${brandConfig.platform.derivws.url.staging}options/ws/public`,
    PRODUCTION: `${brandConfig.platform.derivws.url.production}options/ws/public`,
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

// Helper to check if we're on production.
// NEXT_PUBLIC_DERIV_ENV is the authoritative signal (set at build/deploy time and
// also read by vendored deriv-core for OAuth), so a deployed partner domain resolves the
// same environment for WebSocket and OAuth. Falls back to hostname detection when
// the env var is unset (e.g. local dev).
export const isProduction = () => {
    const env = process.env.NEXT_PUBLIC_DERIV_ENV;
    if (env === 'production') return true;
    if (env === 'preview' || env === 'staging') return false;

    const hostname = window.location.hostname;
    const productionDomains = Object.values(PRODUCTION_DOMAINS) as string[];
    return productionDomains.includes(hostname);
};

export const isLocal = () => /localhost(:\d+)?$/i.test(window.location.hostname);

const getDefaultServerURL = () => {
    const isProductionEnv = isProduction();

    try {
        return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
    } catch (error) {
        console.error('Error in getDefaultServerURL:', error);
    }

    return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
};

/**
 * Gets the WebSocket URL using the authenticated flow
 * 1. Ask the secure backend to issue an OTP using the HttpOnly session cookie
 * 2. Return the account-scoped WebSocket URL without exposing Deriv tokens
 *
 * @returns Promise with WebSocket URL or fallback to default server
 */
export const getSocketURL = async (): Promise<string> => {
    try {
        const accountId = localStorage.getItem('active_loginid');
        if (!accountId) return getDefaultServerURL();

        const response = await fetch('/api/deriv/session', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'otp', accountId }),
        });
        const result = await response.json();
        if (!response.ok || !result.websocketUrl) {
            throw new Error(result.error || 'Could not create authenticated Deriv WebSocket session');
        }
        return result.websocketUrl;
    } catch (error) {
        console.error('[DerivWS] Error in getSocketURL:', error);
        return getDefaultServerURL();
    }
};

export const getDebugServiceWorker = () => {
    const debug_service_worker_flag = window.localStorage.getItem('debug_service_worker');
    if (debug_service_worker_flag) return !!parseInt(debug_service_worker_flag);

    return false;
};

/**
 * Generates the OAuth login or sign-up URL using vendored deriv-core
 *
 * @param prompt - Optional prompt parameter ('registration' for sign-up flow)
 * @returns Promise with the OAuth URL string
 */
export const generateOAuthURL = async (prompt?: string): Promise<string> => {
    try {
        const clientId = process.env.NEXT_PUBLIC_DERIV_APP_ID;
        if (!clientId) return '';

        const config: Record<string, string> = {
            redirectUri: window.location.origin,
            scopes: 'trade',
        };

        // Static referral link (fallback for direct visits without affiliate click)
        const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK;
        if (referralLink) {
            const referral = parseReferralLink(referralLink);
            if (referral) {
                config[referral.affiliateTokenParam || 't'] = referral.affiliateToken;
                if (referral.utmCampaign) config.utm_campaign = referral.utmCampaign;
                if (referral.utmSource) config.utm_source = referral.utmSource;
                if (referral.utmMedium) config.utm_medium = referral.utmMedium;
            }
        }

        // Override with live per-click params from landing URL (e.g. Scaleo t= token)
        const landing = parseLandingParams();
        if (landing) {
            // Only override the token when the landing URL actually carries one
            // (t=). parseLandingParams returns non-null for any utm_* param, so an
            // unguarded write would clobber a valid env token with '' on generic
            // marketing links (e.g. ?utm_source=google with no t=).
            if (landing.affiliateToken) {
                config[landing.affiliateTokenParam || 't'] = landing.affiliateToken;
            }
            if (landing.utmSource) config.utm_source = landing.utmSource;
            if (landing.utmMedium) config.utm_medium = landing.utmMedium;
            if (landing.utmCampaign) config.utm_campaign = landing.utmCampaign;
        }

        // If we still have no token and the referral link is a Scaleo click link,
        // resolve a fresh per-user token via the BFF proxy (non-blocking).
        if (!config.affiliateToken && referralLink) {
            const resolved = await resolveReferralViaProxy(referralLink);
            if (resolved) {
                config[resolved.affiliateTokenParam || 't'] = resolved.affiliateToken;
                if (resolved.utmSource) config.utm_source = resolved.utmSource;
                if (resolved.utmMedium) config.utm_medium = resolved.utmMedium;
                if (resolved.utmCampaign) config.utm_campaign = resolved.utmCampaign;
            }
        }

        const response = await fetch('/api/deriv/oauth/start', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...config, prompt: prompt === 'registration' ? 'registration' : undefined }),
        });
        const result = await response.json();
        if (!response.ok || !result.authorizationUrl) {
            throw new Error(result.error || 'Could not start secure Deriv authorization.');
        }
        return result.authorizationUrl;
    } catch (error) {
        console.error('Error generating OAuth URL:', error);
        return '';
    }
};
