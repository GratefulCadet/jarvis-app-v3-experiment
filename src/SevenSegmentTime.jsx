import {
  AnimatePresence,
  motion,
} from 'motion/react'

function SlidingDigit({
  value,
}) {
  return (
    <span
      className="seven-segment-digit sliding-number-digit"
      aria-hidden="true"
    >
      <AnimatePresence
        initial={false}
        mode="popLayout"
      >
        <motion.span
          key={value}
          className="sliding-number-glyph"
          initial={{
            y: '72%',
            opacity: 0,
            filter: 'blur(3px)',
          }}
          animate={{
            y: '0%',
            opacity: 1,
            filter: 'blur(0px)',
          }}
          exit={{
            y: '-72%',
            opacity: 0,
            filter: 'blur(3px)',
          }}
          transition={{
            type: 'spring',
            stiffness: 420,
            damping: 34,
            mass: 0.8,
          }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
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
        'sliding-number-time',
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
                className="seven-segment-colon sliding-number-colon"
                aria-hidden="true"
              >
                <span />
                <span />
              </span>
            )
          }

          return (
            <SlidingDigit
              key={`digit-${index}`}
              value={character}
            />
          )
        },
      )}
    </span>
  )
}
