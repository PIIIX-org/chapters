import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  changeEmail,
  changePassword,
  disableMfa,
  enableMfa,
  getNotificationPreferences,
  setMfaRequirement,
  startMfaSetup,
  updateNotificationPreferences,
} from '../api/account.js'
import type {
  ChangeEmailInput,
  ChangePasswordInput,
  MfaSetup,
  NotificationPreferences,
} from '../api/account.js'
import { SESSION_QUERY_KEY } from './useSession.js'
import type { ApiError } from '../lib/api.js'

export const NOTIFICATION_PREFS_KEY = ['me', 'preferences'] as const

/** Changing your address clears verification, so the session view is stale. */
export function useChangeEmail() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'verification_sent' }, ApiError, ChangeEmailInput>({
    mutationFn: changeEmail,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    },
  })
}

export function useChangePassword() {
  return useMutation<{ status: 'password_changed' }, ApiError, ChangePasswordInput>({
    mutationFn: changePassword,
  })
}

export function useStartMfaSetup() {
  return useMutation<MfaSetup, ApiError, void>({ mutationFn: startMfaSetup })
}

// Both of these flip `mfaEnabledAt`, which the shell reads to decide whether
// to force enrollment — so the session has to be refetched, not assumed.
export function useEnableMfa() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'enabled'; backupCodes: string[] }, ApiError, string>({
    mutationFn: enableMfa,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    },
  })
}

export function useDisableMfa() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'disabled' }, ApiError, string>({
    mutationFn: disableMfa,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    },
  })
}

export function useNotificationPreferences() {
  return useQuery<NotificationPreferences, ApiError>({
    queryKey: NOTIFICATION_PREFS_KEY,
    queryFn: getNotificationPreferences,
  })
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient()
  return useMutation<NotificationPreferences, ApiError, NotificationPreferences>({
    mutationFn: updateNotificationPreferences,
    onSuccess: (prefs) => {
      queryClient.setQueryData(NOTIFICATION_PREFS_KEY, prefs)
    },
  })
}

/** Admin lever; flipping it changes what every user's Settings page offers. */
export function useSetMfaRequirement() {
  const queryClient = useQueryClient()
  return useMutation<{ required: boolean }, ApiError, boolean>({
    mutationFn: setMfaRequirement,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    },
  })
}
