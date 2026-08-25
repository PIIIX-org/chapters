import { ConfirmAction } from './ConfirmAction.js'
import { useSetMfaRequirement } from '../../hooks/useAccount.js'
import { useSession } from '../../hooks/useSession.js'

/**
 * The instance-wide MFA mandate (MFA spec, "Enforcement"). The endpoint
 * shipped in unit 3 with no way to reach it; this is that way.
 *
 * Both directions confirm, because both reach every account on the instance —
 * turning it on locks everyone without an authenticator out of the rest of the
 * app until they enrol, and turning it off silently weakens every login.
 */
export function MfaRequirementToggle() {
  const session = useSession()
  const setRequirement = useSetMfaRequirement()

  if (!session.data) return null
  const required = session.data.mfaRequired

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-display text-lg text-foreground">Two-factor authentication</h3>
      <p className="text-sm text-muted-foreground">
        {required
          ? 'Required. Anyone without an authenticator app is sent to set one up before they can use anything else, and nobody can turn their own off.'
          : 'Optional. Each person decides for themselves in their own settings.'}
      </p>
      {required ? (
        <ConfirmAction
          label="Stop requiring it"
          destructive
          ariaLabel="Stop requiring two-factor authentication"
          consequence="Every account on this instance can turn its own second factor off again, and new accounts will not be asked to set one up. Existing authenticators keep working."
          pending={setRequirement.isPending}
          error={setRequirement.error?.message ?? null}
          onConfirm={() => setRequirement.mutate(false)}
        />
      ) : (
        <ConfirmAction
          label="Require it"
          ariaLabel="Require two-factor authentication"
          consequence="Everyone without an authenticator app is sent to enrol before they can reach anything else — including you, if you have not set one up. Nobody will be able to turn their own off while this is on."
          pending={setRequirement.isPending}
          error={setRequirement.error?.message ?? null}
          onConfirm={() => setRequirement.mutate(true)}
        />
      )}
    </section>
  )
}
