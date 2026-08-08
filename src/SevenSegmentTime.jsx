const DIGIT_SEGMENTS = {
  0: ['a', 'b', 'c', 'd', 'e', 'f'],
  1: ['b', 'c'],
  2: ['a', 'b', 'd', 'e', 'g'],
  3: ['a', 'b', 'c', 'd', 'g'],
  4: ['b', 'c', 'f', 'g'],
  5: ['a', 'c', 'd', 'f', 'g'],
  6: ['a', 'c', 'd', 'e', 'f', 'g'],
  7: ['a', 'b', 'c'],
  8: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  9: ['a', 'b', 'c', 'd', 'f', 'g'],
}

function SevenSegmentDigit({
  value,
}) {
  const activeSegments =
    DIGIT_SEGMENTS[value] || []

  return (
    <span
      className="seven-segment-digit"
      aria-hidden="true"
    >
      {[
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'g',
      ].map((segment) => (
        <span
          key={segment}
          className={[
            'seven-segment',
            `segment-${segment}`,
            activeSegments.includes(
              segment,
            )
              ? 'is-on'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
        />
      ))}
    </span>
  )
}

export default function SevenSegmentTime({
  value,
  className = '',
}) {
  return (
    <span
      className={[
        'seven-segment-time',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="timer"
      aria-label={value}
    >
      {value.split('').map(
        (character, index) => {
          if (
            character === ':'
          ) {
            return (
              <span
                key={`colon-${index}`}
                className="seven-segment-colon"
                aria-hidden="true"
              >
                <span />
                <span />
              </span>
            )
          }

          return (
            <SevenSegmentDigit
              key={`${character}-${index}`}
              value={character}
            />
          )
        },
      )}
    </span>
  )
}