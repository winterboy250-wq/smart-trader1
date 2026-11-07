import { useEffect, useState } from 'react';
import { setSessionToken as setSessionTokenUtil } from '@/utils/session-token-utils';
import { useStore } from './useStore';

/**
 * Sync session-token changes across tabs without silently refreshing this tab.
 * Account changes are presented to the user so a completed or stopped bot does
 * not cause an unexpected page reload.
 */
export const useLocalStorageSync = () => {
    const store = useStore();
    const [showAccountChangeModal, setShowAccountChangeModal] = useState(false);

    const handleReload = () => {
        // Temporarily disable prompt handler during refresh to prevent Chrome's native dialog.
        if (store?.ui?.setPromptHandler) {
            store.ui.setPromptHandler(false);
        }

        setTimeout(() => {
            window.location.reload();
        }, 100);
    };

    const handleModalClose = () => {
        setShowAccountChangeModal(false);
    };

    useEffect(() => {
        const handleStorageChange = (event: StorageEvent) => {
            if (event.key !== 'session_token' || event.newValue === event.oldValue) {
                return;
            }

            // Never reload automatically: the bot may have just finished and its
            // running flag may already be false. Let the user decide when to switch.
            setShowAccountChangeModal(true);
        };

        window.addEventListener('storage', handleStorageChange);
        return () => {
            window.removeEventListener('storage', handleStorageChange);
        };
    }, []);

    /** Store a session token in the current tab. */
    const setSessionToken = (token: string) => {
        setSessionTokenUtil(token);
    };

    return {
        setSessionToken,
        showAccountChangeModal,
        handleReload,
        handleModalClose,
    };
};
