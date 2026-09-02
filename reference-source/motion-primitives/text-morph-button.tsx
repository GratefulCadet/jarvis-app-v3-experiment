'use client';
import { useState } from 'react';
import { TextMorph } from '@/components/core/text-morph';

export function TextMorphButton() {
  const [text, setText] = useState('Continue');

  return (
    <button
      onClick={() => setText(text === 'Continue' ? 'Confirm' : 'Continue')}
      className='flex h-10 w-[120px] shrink-0 items-center justify-center rounded-full bg-black px-4 text-base font-medium text-zinc-50 shadow-xs transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-black dark:hover:bg-zinc-200'
    >
      <TextMorph>{text}</TextMorph>
    </button>
  );
}

// This component might be used as a button that toggles its text between "Continue" and "Confirm" when clicked. It uses the `TextMorph` component to animate the text change smoothly. In this Jarvis project, it could be part of a user interface where the user is prompted to confirm an action, and the button provides visual feedback through the text morphing effect.
