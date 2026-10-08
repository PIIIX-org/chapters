import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useCreateVault } from '../../hooks/useVaultMutations.js'
import type { Vault } from '../../api/vaults.js'
import { toast } from '../../lib/toast.js'

interface NewVaultFormProps {
  onCreated: (vault: Vault) => void
  onCancel?: () => void
}

export function NewVaultForm({ onCreated, onCancel }: NewVaultFormProps) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createVault = useCreateVault()

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setError('Give the vault a name.')
      return
    }
    if (name.length > 200) {
      setError('A vault name can be at most 200 characters.')
      return
    }
    setError(null)
    createVault.mutate(trimmed, {
      onSuccess: (vault) => {
        setName('')
        toast.success('Vault created', `${vault.name} created successfully.`)
        onCreated(vault)
      },
      onError: (err) => {
        const msg = err.message || 'Could not create the vault.'
        toast.error('Failed to create vault', msg)
        setError(msg)
      },
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
      <Label htmlFor="nv-name" className="text-xs font-medium">Vault name</Label>
      <Input
        id="nv-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Engineering"
        autoFocus
        className="h-9 sm:h-8 text-sm sm:text-xs"
      />
      <FormError message={error} />
      <div className="flex items-center gap-2 pt-0.5">
        <Button type="submit" disabled={createVault.isPending} className="flex-1 sm:flex-initial h-9 sm:h-8 text-xs">
          {createVault.isPending ? 'Creating…' : 'Create vault'}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={createVault.isPending}
            className="flex-1 sm:flex-initial h-9 sm:h-8 text-xs text-muted-foreground"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

