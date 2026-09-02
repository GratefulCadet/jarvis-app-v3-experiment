export const TREE_PROTOTYPE_ROOT = {
  id: 'jarvis-system',
  label: 'JARVIS System',
  eyebrow: 'SYSTEM HOME',
  description:
    'A spatial home for goals, current state, time, context, and future tools.',
  children: [
    {
      id: 'goals-projects',
      label: 'Goals / Projects',
      eyebrow: 'PRIMARY BRANCH',
      description:
        'Large goals that can be entered, decomposed, and turned into execution.',
      children: [
        {
          id: 'jarvis-app',
          label: 'JARVIS App',
          eyebrow: 'GOAL',
          description:
            'Build the personal computing interface and task hierarchy.',
          children: [
            {
              id: 'jarvis-tree',
              label: 'Hierarchy Navigation',
              eyebrow: 'TASK',
              description:
                'Move from a large goal into smaller tasks from the Core outward.',
              children: [
                {
                  id: 'jarvis-tree-system-home',
                  label: 'System Home Entry',
                  eyebrow: 'SUBTASK',
                  description:
                    'Make fullscreen open into the map of goals instead of a timer screen.',
                  children: [
                    {
                      id: 'jarvis-tree-system-home-execution',
                      label: 'Validate Home Flow',
                      eyebrow: 'EXECUTION',
                      description:
                        'Open the execution layer after choosing the right system path.',
                      children: [],
                    },
                  ],
                },
                {
                  id: 'jarvis-tree-depth-motion',
                  label: 'Depth Motion',
                  eyebrow: 'SUBTASK',
                  description:
                    'Make each click feel like entering a deeper spatial layer.',
                  children: [
                    {
                      id: 'jarvis-tree-depth-motion-execution',
                      label: 'Tune Spatial Transition',
                      eyebrow: 'EXECUTION',
                      description:
                        'Review whether nodes feel pulled outward from the Core.',
                      children: [],
                    },
                  ],
                },
                {
                  id: 'jarvis-tree-overview',
                  label: 'Overview Map',
                  eyebrow: 'SUBTASK',
                  description:
                    'Keep a small system map visible while navigating into one branch.',
                  children: [
                    {
                      id: 'jarvis-tree-overview-execution',
                      label: 'Check Map Legibility',
                      eyebrow: 'EXECUTION',
                      description:
                        'Use the existing execution layer to test whether the map helps recovery.',
                      children: [],
                    },
                  ],
                },
              ],
            },
            {
              id: 'jarvis-pip',
              label: 'PiP Presence',
              eyebrow: 'TASK',
              description:
                'Keep JARVIS present without becoming visual clutter.',
              children: [
                {
                  id: 'jarvis-pip-monochrome',
                  label: 'Core Color Continuity',
                  eyebrow: 'EXECUTION',
                  description:
                    'Confirm PiP uses the same monochrome Core identity as fullscreen.',
                  children: [],
                },
              ],
            },
            {
              id: 'jarvis-visual-system',
              label: 'Visual System',
              eyebrow: 'TASK',
              description:
                'Shape the fullscreen interface into a mature desktop system.',
              children: [
                {
                  id: 'jarvis-visual-system-execution',
                  label: 'Market-Facing Pass',
                  eyebrow: 'EXECUTION',
                  description:
                    'Review whether the interface feels like a product, not a demo.',
                  children: [],
                },
              ],
            },
          ],
        },
        {
          id: 'graduation-thesis',
          label: 'Graduation Thesis',
          eyebrow: 'GOAL',
          description:
            'Raindrop removal research, experiments, evaluation, and writing.',
          children: [
            {
              id: 'thesis-dataset',
              label: 'Dataset',
              eyebrow: 'TASK',
              description:
                'Inspect paired rainy/clean data and preprocessing.',
              children: [
                {
                  id: 'thesis-dataset-execution',
                  label: 'Dataset Audit',
                  eyebrow: 'EXECUTION',
                  description:
                    'Open an execution session for the next concrete dataset check.',
                  children: [],
                },
              ],
            },
            {
              id: 'thesis-evaluation',
              label: 'Evaluation',
              eyebrow: 'TASK',
              description:
                'Compare restoration metrics and visible failure modes.',
              children: [
                {
                  id: 'thesis-evaluation-execution',
                  label: 'Metric Comparison',
                  eyebrow: 'EXECUTION',
                  description:
                    'Open execution for the next evaluation slice.',
                  children: [],
                },
              ],
            },
          ],
        },
        {
          id: 'career',
          label: 'Career',
          eyebrow: 'GOAL',
          description:
            'Applications, portfolio, and long-term positioning.',
          children: [
            {
              id: 'career-applications',
              label: 'Applications',
              eyebrow: 'TASK',
              description:
                'Prepare company-specific application materials.',
              children: [
                {
                  id: 'career-applications-execution',
                  label: 'Next Application',
                  eyebrow: 'EXECUTION',
                  description:
                    'Open execution for the next concrete application step.',
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'calendar',
      label: 'Calendar',
      eyebrow: 'FUTURE BRANCH',
      description:
        'Time commitments and upcoming constraints. Placeholder only.',
      children: [],
    },
    {
      id: 'personal-state',
      label: 'Personal State',
      eyebrow: 'FUTURE BRANCH',
      description:
        'Energy, context, reminders, and recovery cues. Placeholder only.',
      children: [],
    },
    {
      id: 'external-world',
      label: 'External World',
      eyebrow: 'FUTURE BRANCH',
      description:
        'Weather, news, messages, and outside signals. Placeholder only.',
      children: [],
    },
  ],
}
