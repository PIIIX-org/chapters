import { useState } from 'react'
import { ConfirmStep } from './ConfirmAction.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { Switch } from '../ui/switch.js'
import { useSetMfaRequirement } from '../../hooks/useAccount.js'
import { useSession } from '../../hooks/useSession.js'

/**
 * The instance-wide MFA mandate (MFA spec, "Enforcement"). The endpoint
 * shipped in unit 3 with no way to reach it; this is that way.
 *
 * Both directions confirm, because both reach every account on the instance —
 * turning it on locks everyone without an authenticator out of the rest of the
 * app until they enrol, and turning it off silently weakens every login. The
 * switch therefore never flips on click: it reflects the server's answer, and
 * only the confirmed mutation changes that answer.
 */
export function MfaRequirementToggle() {
  const session = useSession()
  const setRequirement = useSetMfaRequirement()
  const [confirming, setConfirming] = useState(false)

  if (!session.data) return null
  const required = session.data.mfaRequired

  return (
    <Panel>
      <PanelHeader
        title="Two-factor authentication"
        actions={
          <Switch
            checked={required}
            aria-label={
              required
                ? 'Stop requiring two-factor authentication'
                : 'Require two-factor authentication'
            }
            disabled={setRequirement.isPending}
            onCheckedChange={() => setConfirming(true)}
          />
        }
      />
      <PanelBody className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">
          {required
            ? 'Required. Anyone without an authenticator app is sent to set one up before they can use anything else, and nobody can turn their own off.'
            : 'Optional. Each person decides for themselves in their own settings.'}
        </p>
        {confirming && (
          <ConfirmStep
            label={required ? 'Stop requiring it' : 'Require it'}
            destructive={required}
            consequence={
              required
                ? 'Every account on this instance can turn its own second factor off again, and new accounts will not be asked to set one up. Existing authenticators keep working.'
                : 'Everyone without an authenticator app is sent to enrol before they can reach anything else — including you, if you have not set one up. Nobody will be able to turn their own off while this is on.'
            }
            pending={setRequirement.isPending}
            error={setRequirement.error?.message ?? null}
            onConfirm={() =>
              setRequirement.mutate(!required, { onSuccess: () => setConfirming(false) })
            }
            onCancel={() => setConfirming(false)}
          />
        )}
      </PanelBody>
    </Panel>
  )
}
