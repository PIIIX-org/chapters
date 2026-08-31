import { Label } from '../ui/label.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.js'
import { useTheme } from '../../hooks/useTheme.js'
import { isThemePreference, type ThemePreference } from '../../lib/theme.js'

const OPTIONS: ReadonlyArray<{
  value: ThemePreference
  label: string
  description: string
}> = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'The console default: dark canvas, light text.',
  },
  {
    value: 'light',
    label: 'Light',
    description: 'The same layout and roles on a light canvas.',
  },
  {
    value: 'system',
    label: 'System',
    description:
      "Follows your operating system's appearance setting, and switches whenever it does.",
  },
]

/**
 * Theme preference — the spec's "Appearance holds the theme switch". Saved
 * per browser (localStorage), not on the account: the same person can want
 * different faces on different machines.
 */
export function AppearanceSection() {
  const theme = useTheme()

  return (
    <Panel>
      <PanelHeader title="Appearance" />
      <PanelBody className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          How Chapters looks on this device. The choice is saved in this browser only.
        </p>
        <RadioGroup
          aria-label="Theme"
          value={theme.preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) theme.setPreference(value)
          }}
          className="gap-1"
        >
          {OPTIONS.map((option) => (
            <div key={option.value} className="flex items-start gap-2.5 rounded-md p-1.5">
              <RadioGroupItem
                id={`theme-${option.value}`}
                value={option.value}
                className="mt-0.5"
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={`theme-${option.value}`}>{option.label}</Label>
                <p className="text-xs text-muted-foreground">{option.description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </PanelBody>
    </Panel>
  )
}
