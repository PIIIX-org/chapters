import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useCreateVault } from '../../hooks/useVaultMutations.js'
import type { Vault } from '../../api/vaults.js'

interface NewVaultFormProps {
  onCreated: (vault: Vault) => void
}

export function NewVaultForm({ onCreated }: NewVaultFormProps) {
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
        onCreated(vault)
      },
      onError: (err) => setError(err.message || 'Could not create the vault.'),
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Label htmlFor="nv-name">Vault name</Label>
      <Input
        id="nv-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Engineering"
      />
      <FormError message={error} />
      <Button type="submit" disabled={createVault.isPending}>
        {createVault.isPending ? 'Creating…' : 'Create vault'}
      </Button>
    </form>
  )
}
