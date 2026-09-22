export default function FocusIndicator({ executionContext }) {
  const label = executionContext?.node?.label

  if (!label) {
    return null
  }

  return (
    <div className="jarvis-focus-indicator" aria-label="Current focus">
      <span className="jarvis-focus-label">FOCUS</span>
      <span>{label}</span>
    </div>
  )
}
