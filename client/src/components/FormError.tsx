interface FormErrorProps {
  message: string | null
}

/** Inline form failure: destructive text, announced through role="alert". */
export function FormError({ message }: FormErrorProps) {
  if (!message) return null
  return (
    <p
      role="alert"
      data-slot="form-error"
      className="text-[13px] leading-snug text-destructive"
    >
      {message}
    </p>
  )
}
