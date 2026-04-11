export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: AppLocale = 'en'

type MessageTree = {
  [key: string]: string | MessageTree
}

export const messages: Record<AppLocale, MessageTree> = {
  en: {
    settings: {
      title: 'Settings',
      sections: {
        appearance: 'Appearance',
        general: 'General',
        models: 'Models',
        editor: 'Editor',
        terminal: 'Terminal',
        security: 'Security',
        privacy: 'Privacy',
        usage: 'Usage',
        shortcuts: 'Shortcuts',
        updates: 'Updates'
      },
      appearance: {
        title: 'Appearance',
        description: 'Choose a theme for the application.',
        darkThemes: 'Dark Themes',
        lightThemes: 'Light Themes'
      },
      general: {
        title: 'General',
        description: 'Basic application settings',
        language: {
          label: 'Language',
          description:
            'Choose the display language for translated UI copy. More screens will be localized incrementally.',
          options: {
            en: 'English',
            zhCN: 'Simplified Chinese'
          }
        },
        autoStartSession: {
          label: 'Auto-start session',
          description: 'Automatically create a session when selecting a worktree with none'
        },
        vimMode: {
          label: 'Vim mode',
          description:
            'Enable vim-style keyboard navigation with hints, hjkl scrolling, and mode switching'
        },
        modelIcons: {
          label: 'Model icons',
          description: 'Show the model icon (Claude, OpenAI) next to the worktree status'
        },
        modelProvider: {
          label: 'Show model provider',
          description:
            'Display the provider name (e.g. ANTHROPIC) next to the model in the selector pill'
        },
        usageIndicator: {
          label: 'Show usage indicator',
          description:
            'Show Claude API usage bars below projects. When off, shows spaces tab instead.'
        },
        aiProvider: {
          label: 'AI Provider',
          description:
            'Choose which AI coding agent to use for new sessions. Existing sessions keep their original provider.',
          terminalHint:
            'Opens a terminal window. Run any AI tool manually (claude, aider, cursor, etc.)'
        },
        stripAtMentions: {
          label: 'Strip @ from file mentions',
          description:
            'Remove the @ symbol from file references inserted via the file picker before sending'
        },
        branchNaming: {
          label: 'Branch Naming',
          description: 'Choose the naming theme for auto-generated worktree branches',
          options: {
            dogs: 'Dogs',
            cats: 'Cats'
          }
        },
        resetAll: {
          label: 'Reset all settings',
          description:
            'This will reset all settings, theme, and keyboard shortcuts to their defaults.',
          success: 'All settings reset to defaults'
        }
      },
      editor: {
        title: 'Editor',
        description: 'Choose which editor to use for "Open in Editor" actions',
        detecting: 'Detecting installed editors...',
        notFound: '(not found)',
        customCommand: {
          label: 'Custom Editor Command',
          description: 'The command will be called with the worktree path as an argument.',
          optionLabel: 'Custom Command'
        }
      },
      models: {
        title: 'Default Models',
        description: 'Configure which AI models to use for different modes and commands',
        priority: {
          title: 'Model selection priority:',
          worktree: "Worktree's last-used model (if any)",
          mode: 'Mode-specific default (configured below)',
          global: 'Global default model',
          fallback: 'System fallback (Claude Opus 4.5)'
        },
        global: {
          label: 'Global Default Model',
          fallbackDescription: 'Fallback model used when no mode-specific default is configured',
          sessionDescription: 'Model used for all new sessions',
          clear: 'Clear'
        },
        build: {
          label: 'Build Mode Default',
          description: 'Model used for new build mode sessions (normal coding)'
        },
        plan: {
          label: 'Plan Mode Default',
          description: 'Model used for new plan mode sessions (design and planning)'
        },
        ask: {
          label: '/ask Command Default',
          description: 'Model used when you run the /ask command for quick questions'
        },
        useGlobal: 'Use global',
        profiles: {
          title: 'Model Profiles',
          description:
            'Create named configurations with custom API keys and endpoints. Assign them to projects or worktrees.',
          add: 'Add Profile',
          edit: 'Edit Profile',
          create: 'Create Profile',
          delete: 'Delete',
          deleteConfirm:
            'Delete this profile? Projects and worktrees using it will fall back to the global default.',
          setDefault: 'Set as Default',
          removeDefault: 'Remove Default',
          default: 'Default',
          name: 'Name',
          namePlaceholder: 'e.g. Personal, Company',
          provider: 'Provider',
          apiKey: 'API Key',
          apiKeyPlaceholder: 'sk-ant-...',
          baseUrl: 'Base URL',
          baseUrlPlaceholder: 'https://api.anthropic.com (optional)',
          openaiApiKey: 'OpenAI API Key',
          openaiApiKeyPlaceholder: 'sk-...',
          openaiBaseUrl: 'OpenAI Base URL',
          openaiBaseUrlPlaceholder: 'https://api.openai.com/v1 (optional)',
          codexConfigToml: 'Config (config.toml)',
          codexConfigTomlHint: 'Paste your ~/.codex/config.toml content. API key is injected via OPENAI_API_KEY.',
          modelId: 'Default Model',
          modelIdPlaceholder: 'e.g. claude-sonnet-4-20250514 (optional)',
          advancedSettings: 'Advanced Settings (JSON)',
          noProfiles: 'No profiles configured. Add one to get started.',
          useGlobalDefault: 'Use Global Default',
          useProjectDefault: 'Use Project Default',
          none: 'None'
        }
      },
      terminal: {
        embedded: {
          title: 'Embedded Terminal',
          description: 'Choose the rendering engine for the built-in terminal panel',
          xtermLabel: 'Built-in (xterm.js)',
          xtermDescription: 'Cross-platform terminal emulator. Always available.',
          ghosttyLabel: 'Ghostty (native)',
          ghosttyDescription: 'Native Metal rendering on macOS. Requires Ghostty.',
          macOnly: '(macOS only)',
          notAvailable: '(not available)',
          info: 'Ghostty renders via Metal for native performance. The terminal will restart when switching backends. Colors and cursor style are read from your Ghostty config.',
          fontSizeLabel: 'Font Size',
          fontSizeUnit: 'pt (8-32)',
          fontSizeDescription:
            'Font size for the embedded Ghostty terminal. Restart the terminal for changes to take effect.',
          fontFamilyLabel: 'Terminal Font',
          fontFamilyDescription:
            'CSS font-family for the embedded terminal. Leave empty to auto-detect or use default. Use Nerd Font names (e.g. "MesloLGS Nerd Font") for icon glyph support.'
        },
        external: {
          title: 'External Terminal',
          description: 'Choose which terminal to use for "Open in Terminal" actions',
          detecting: 'Detecting installed terminals...',
          notFound: '(not found)',
          customCommand: {
            label: 'Custom Terminal Command',
            description: 'The command will be called with the worktree path as an argument.',
            optionLabel: 'Custom Command'
          }
        }
      },
      security: {
        title: 'Security',
        description: 'Control command filtering for approval-based agent sessions',
        enable: {
          label: 'Enable command filtering',
          description:
            'Control which tools and commands approval-based agents can use during sessions'
        },
        defaultBehavior: {
          label: 'Default behavior for unlisted commands',
          description: 'How to handle commands not on either list',
          ask: 'Ask for approval',
          allow: 'Allow silently',
          block: 'Block silently'
        },
        info: {
          title: 'Pattern matching with wildcards:',
          single: '* matches any sequence except /',
          double: '** matches any sequence including /',
          exampleBash: 'Example: bash: npm * matches all npm commands',
          exampleRead: 'Example: read: src/** matches any file in src/'
        },
        priority: {
          title: 'Priority:',
          description:
            'Blocklist takes precedence over allowlist. If a command matches both, it will be blocked.'
        },
        tabs: {
          allowlist: 'Allowlist',
          blocklist: 'Blocklist'
        },
        pattern: {
          empty: 'Pattern cannot be empty',
          duplicate: 'Pattern already exists in this list',
          added: 'Pattern added to {list}',
          removed: 'Pattern removed from {list}',
          allowPlaceholder: 'e.g., bash: git status or read: src/**',
          blockPlaceholder: 'e.g., bash: rm -rf * or edit: .env',
          add: 'Add',
          searchPlaceholder: 'Search patterns...',
          showingCount: 'Showing {visible} of {total} patterns',
          noAllowlist: 'No patterns in allowlist. Commands will follow the default behavior.',
          noAllowlistSearch: 'No patterns matching "{query}"',
          noBlocklist:
            'No patterns in blocklist. Default dangerous patterns are included on first launch.',
          noBlocklistSearch: 'No patterns matching "{query}"',
          removeTitle: 'Remove pattern'
        }
      },
      privacy: {
        title: 'Privacy',
        description: 'Control how Xuanpu collects anonymous usage data',
        analytics: {
          label: 'Send anonymous usage analytics',
          description: 'Help improve Xuanpu by sharing anonymous feature usage data'
        },
        collect: {
          title: 'What we collect:',
          description: 'Feature usage counts, app version, platform (macOS/Windows/Linux).'
        },
        neverCollect: {
          title: 'What we never collect:',
          description:
            'Project names, file contents, prompts, AI responses, git data, or any personal information.'
        }
      },
      shortcuts: {
        title: 'Keyboard Shortcuts',
        description: 'Customize keyboard shortcuts',
        resetAll: 'Reset All',
        resetAllSuccess: 'All shortcuts reset to defaults',
        resetOneSuccess: 'Shortcut reset to default',
        modifierRequired: 'Shortcuts must include at least one modifier key (Cmd/Ctrl/Alt/Shift)',
        updated: 'Shortcut updated to {binding}',
        conflictTitle: 'Shortcut conflict',
        conflictDescription: 'This binding is already used by:',
        resetTitle: 'Reset to default',
        recording: 'Press keys...',
        categories: {
          recent: 'Recent',
          navigation: 'Navigation',
          action: 'Actions',
          git: 'Git',
          settings: 'Settings',
          file: 'File'
        }
      },
      updates: {
        title: 'Updates',
        description: 'Manage how Xuanpu updates itself',
        currentVersion: 'Current version:',
        channel: {
          label: 'Update Channel',
          description: 'Choose which release channel to receive updates from',
          stable: 'Stable',
          canary: 'Canary',
          stableHint: 'You will receive stable, tested releases.',
          canaryHint:
            'You will receive early builds with the latest features. These may contain bugs.'
        },
        check: {
          idle: 'Check for Updates',
          busy: 'Checking...'
        }
      },
      usage: {
        title: 'Usage Analytics',
        description: 'Review local session cost and token usage for Claude and Codex.',
        actions: {
          refresh: 'Refresh',
          resync: 'Resync'
        },
        filters: {
          range: 'Range',
          engine: 'Engine'
        },
        ranges: {
          today: 'Today',
          '7d': 'Last 7 Days',
          '30d': 'Last 30 Days',
          all: 'All Time'
        },
        engines: {
          all: 'All Engines',
          'claude-code': 'Claude',
          codex: 'OpenAI Codex'
        },
        summary: {
          totalCost: 'Total Cost',
          totalSessions: 'Sessions',
          totalTokens: 'Tokens',
          averageCostPerSession: 'Avg Cost / Session'
        },
        tokens: {
          input: 'Input Tokens',
          output: 'Output Tokens',
          cacheWrite: 'Cache Write',
          cacheRead: 'Cache Read'
        },
        tabs: {
          overview: 'Overview',
          models: 'By Model',
          projects: 'By Project',
          sessions: 'Sessions',
          timeline: 'Timeline'
        },
        overview: {
          topModels: 'Top Models',
          topProjects: 'Top Projects'
        },
        tables: {
          model: 'Model',
          project: 'Project',
          session: 'Session',
          sessions: 'Sessions',
          tokens: 'Tokens',
          cost: 'Cost',
          lastUsed: 'Last Used'
        },
        partial: {
          partialCount: '{count} sessions have incomplete analytics data.',
          staleCount: '{count} sessions are being refreshed in the background.'
        },
        empty: 'No usage data available for the selected range.'
      }
    },
    fileSearch: {
      ariaLabel: 'File search',
      commandLabel: 'File search',
      placeholder: 'Search files by name or path...',
      empty: 'No files found.',
      hints: {
        navigate: 'navigate',
        open: 'open',
        close: 'close'
      },
      fileCount: '{count} files'
    },
    fileMentionPopover: {
      noFiles: 'No files found'
    },
    attachmentButton: {
      label: 'Attach image or file'
    },
    fileTree: {
      ariaLabel: 'File tree',
      node: {
        ariaLabel: '{prefix}{kind}: {name}{status}',
        symlinkedPrefix: 'Symlinked',
        folder: 'Folder',
        file: 'File',
        staged: 'staged',
        modified: 'modified'
      },
      header: {
        title: 'Files',
        collapseAll: 'Collapse all folders',
        refresh: 'Refresh file tree',
        closeSidebar: 'Close sidebar'
      },
      filter: {
        placeholder: 'Filter files...',
        clear: 'Clear filter'
      },
      sidebar: {
        changes: 'Changes',
        files: 'Files',
        diffs: 'Diffs',
        comments: 'Comments',
        closeSidebar: 'Close sidebar'
      },
      empty: {
        noWorktreeTitle: 'Select a worktree',
        noWorktreeHint: 'to view its files',
        errorTitle: 'Error loading files',
        loading: 'Loading files...',
        loadingAria: 'Loading files',
        noFiles: 'No files found'
      },
      branchDiff: {
        noWorktree: 'No worktree selected',
        selectBranch: 'Select branch to compare...',
        filterBranches: 'Filter branches...',
        local: 'Local',
        remote: 'Remote',
        current: 'current',
        noBranches: 'No branches found',
        selectBranchToSeeDifferences: 'Select a branch to see differences',
        loading: 'Loading...',
        noDifferences: 'No differences',
        loadError: 'Failed to load diff files',
        changedCount: '{count} {label} changed',
        fileSingular: 'file',
        filePlural: 'files',
        noBranchSelected: 'No branch selected',
        refresh: 'Refresh'
      },
      changes: {
        noWorktree: 'No worktree selected',
        refresh: 'Refresh git status',
        refreshAll: 'Refresh all',
        branchLoading: 'Loading...',
        noChanges: 'No changes',
        mergeConflicts: 'Merge Conflicts',
        stagedChanges: 'Staged Changes',
        changes: 'Changes',
        untracked: 'Untracked',
        markResolved: 'Mark as Resolved',
        openDiff: 'Open Diff',
        openSourceFile: 'Open Source File',
        copyPath: 'Copy Path',
        pathCopied: 'Path copied to clipboard',
        unstage: 'Unstage',
        stage: 'Stage',
        discardChanges: 'Discard Changes',
        delete: 'Delete',
        addToGitignore: 'Add to .gitignore',
        stageAll: 'Stage All',
        unstageAll: 'Unstage All',
        discard: 'Discard',
        stageAllTitle: 'Stage all files',
        unstageAllTitle: 'Unstage all files',
        discardAllTitle: 'Discard all changes',
        clean: 'clean',
        connectionNoChanges: 'No changes',
        connectionSummary: '{files} {fileLabel} across {repos} {repoLabel}',
        fileSingular: 'file',
        filePlural: 'files',
        repoSingular: 'repo',
        repoPlural: 'repos',
        aheadTooltip: '{count} commit(s) ahead',
        behindTooltip: '{count} commit(s) behind',
        toasts: {
          stageAllSuccess: 'All changes staged',
          stageAllError: 'Failed to stage changes',
          unstageAllSuccess: 'All changes unstaged',
          unstageAllError: 'Failed to unstage changes',
          discardAllSuccess: 'Discarded {count} change(s)',
          discardPartial: 'Discarded {success}/{total} changes',
          discardAllError: 'Failed to discard changes',
          stageFileError: 'Failed to stage {path}',
          unstageFileError: 'Failed to unstage {path}',
          discardFileSuccess: 'Discarded changes to {path}',
          discardFileError: 'Failed to discard {path}',
          addToGitignoreSuccess: 'Added {path} to .gitignore',
          addToGitignoreError: 'Failed to add to .gitignore'
        }
      },
      gitStatus: {
        modified: 'Modified',
        staged: 'Staged',
        deleted: 'Deleted',
        untracked: 'Untracked',
        conflicted: 'Conflicted',
        stagedSuffix: ' (staged)'
      }
    },
    fileViewer: {
      loading: 'Loading file...',
      errorTitle: 'Error loading file',
      noContent: 'No content',
      source: 'Source',
      preview: 'Preview',
      errors: {
        readImage: 'Failed to read image',
        readFile: 'Failed to read file',
        deletedFromDisk: 'File was deleted from disk'
      },
      toasts: {
        saved: 'File saved',
        saveError: 'Failed to save: {error}'
      },
      externalChanges: {
        message: 'This file has been changed on disk.',
        keepMine: 'Keep Mine',
        reload: 'Reload'
      },
      unsavedChanges: {
        title: 'Unsaved Changes',
        description: 'Do you want to save changes to {fileName}?',
        dontSave: "Don't Save",
        cancel: 'Cancel',
        save: 'Save'
      }
    },
    quickActions: {
      openInXcode: 'Open in Xcode',
      openInAndroidStudio: 'Open in Android Studio',
      openInApp: 'Open in {app}',
      revealInManager: 'Reveal in {manager}',
      copyPath: 'Copy Path',
      copyBranchName: 'Copy branch name',
      copied: 'Copied'
    },
    terminalToolbar: {
      status: {
        starting: 'Starting...',
        terminal: 'Terminal',
        ghostty: 'Ghostty',
        exited: 'Exited ({code})'
      },
      search: {
        placeholder: 'Search...',
        previous: 'Previous match (Shift+Enter)',
        next: 'Next match (Enter)',
        close: 'Close search (Escape)'
      },
      actions: {
        search: 'Search (Cmd+F)',
        clear: 'Clear terminal (Cmd+K)',
        restart: 'Restart terminal'
      }
    },
    runOutputSearch: {
      placeholder: 'Find in output...',
      count: '{current} of {total}',
      noResults: 'No results',
      previous: 'Previous match (Shift+Enter)',
      next: 'Next match (Enter)',
      close: 'Close (Escape)'
    },
    setupTab: {
      empty: {
        noWorktree: 'Select a worktree to view setup output',
        noOutput: 'No setup output yet. Click "Rerun Setup" to execute.',
        configure: 'Configure setup script'
      },
      status: {
        running: 'Running...',
        complete: 'Setup complete',
        failed: 'Setup failed'
      },
      actions: {
        rerun: 'Rerun Setup'
      }
    },
    copyMessageButton: {
      ariaLabel: 'Copy message',
      toasts: {
        copied: 'Copied to clipboard',
        copyError: 'Failed to copy'
      }
    },
    codeBlock: {
      copyButton: 'Copy code',
      toasts: {
        copied: 'Code copied to clipboard',
        copyError: 'Failed to copy code'
      }
    },
    errorFallback: {
      title: 'Something went wrong',
      message: 'An unexpected error occurred',
      retry: 'Try Again'
    },
    updateToast: {
      available: {
        title: 'Update v{version} available',
        later: 'Later',
        skip: 'Skip this version',
        download: 'Download'
      },
      progress: {
        title: 'Downloading v{version}...'
      }
    },
    ghosttyPromoToast: {
      title: 'Ghostty native terminal available',
      description: 'Metal-accelerated rendering with your Ghostty config',
      dismiss: "Don't show again",
      activate: 'Activate'
    },
    compactionPill: {
      auto: 'Auto-compacted',
      manual: 'Context compacted'
    },
    indeterminateProgressBar: {
      asking: 'Waiting for answer',
      working: 'Agent is working'
    },
    gitCommitForm: {
      summaryPlaceholder: 'Commit summary',
      descriptionPlaceholder: 'Extended description (optional)',
      committing: 'Committing...',
      commit: 'Commit',
      stagedCount: '{count} {label}',
      fileSingular: 'file',
      filePlural: 'files',
      conflictWarning: 'Resolve merge conflicts before committing',
      shortcutHint: '{modifier}+Enter to commit',
      toasts: {
        success: 'Changes committed successfully',
        commitHash: 'Commit: {hash}',
        error: 'Failed to commit'
      }
    },
    gitPushPull: {
      actions: {
        push: 'Push',
        pull: 'Pull',
        merge: 'Merge',
        archive: 'Archive',
        delete: 'Delete'
      },
      merge: {
        label: 'Merge from',
        select: 'Select branch',
        filterPlaceholder: 'Filter branches...',
        loading: 'Loading...',
        noMatching: 'No matching branches',
        noBranches: 'No branches found'
      },
      toasts: {
        pushSuccess: 'Pushed successfully',
        pushError: 'Push failed',
        pullSuccess: 'Pulled successfully',
        pullError: 'Pull failed',
        deleteSuccess: 'Deleted branch {branch}',
        deleteError: 'Failed to delete branch',
        mergeSuccess: 'Merged {branch} successfully',
        mergeError: 'Merge failed'
      }
    },
    gitStatusPanel: {
      ariaLabel: 'Git status',
      loading: 'Loading...',
      refresh: 'Refresh git status',
      noChanges: 'No changes',
      ahead: '{count} commit(s) ahead',
      behind: '{count} commit(s) behind',
      conflictsTitle: '{count} file(s) with merge conflicts - click to fix with AI',
      conflictsButton: 'CONFLICTS',
      unknownBranch: 'unknown',
      conflictSessionName: 'Merge Conflicts: {branch}',
      pendingMessage: 'Fix merge conflicts',
      sections: {
        conflicts: 'Conflicts',
        staged: 'Staged Changes',
        changes: 'Changes',
        untracked: 'Untracked'
      },
      actions: {
        stageAll: 'Stage All',
        stageAllTitle: 'Stage all files',
        unstageAll: 'Unstage All',
        unstageAllTitle: 'Unstage all files'
      },
      fileItem: {
        stageFile: 'Stage {path}',
        unstageFile: 'Unstage {path}',
        viewChanges: 'View changes',
        viewChangesTitle: 'View changes: {path}'
      },
      toasts: {
        stageAllSuccess: 'All changes staged',
        stageAllError: 'Failed to stage changes',
        unstageAllSuccess: 'All changes unstaged',
        unstageAllError: 'Failed to unstage changes',
        stageFileError: 'Failed to stage {path}',
        unstageFileError: 'Failed to unstage {path}',
        noWorktreeSelected: 'No worktree selected',
        projectNotFound: 'Could not find project for worktree',
        createSessionError: 'Failed to create session',
        conflictResolutionError: 'Failed to start conflict resolution',
        pathCopied: 'Path copied to clipboard'
      },
      contextMenu: {
        openSourceFile: 'Open Source File',
        viewChanges: 'View Changes',
        copyPath: 'Copy Path'
      }
    },
    projectList: {
      error: {
        title: 'Failed to load projects'
      },
      empty: {
        noProjects: 'No projects added yet.',
        addProjectHint: 'Click + to add a project.',
        noProjectsInSpace: 'No projects in this space.',
        assignHint: 'Right-click a project to assign it.',
        noMatches: 'No matching projects'
      }
    },
    terminalManager: {
      empty: {
        selectWorktree: 'Select a worktree to open a terminal'
      }
    },
    terminalTabBar: {
      rename: 'Rename',
      close: 'Close',
      closeOthers: 'Close Others',
      newTerminal: 'New terminal'
    },
    appLayout: {
      sidebarError: 'Sidebar Error',
      drop: {
        noSession: 'Open a session to attach files',
        noFolders: 'Folders cannot be attached. Drop individual files instead.',
        maxFiles: 'Maximum {count} files per drop',
        readError: 'Failed to read one or more dropped files'
      }
    },
    loading: {
      default: 'Loading...'
    },
    connectionList: {
      title: 'Connections'
    },
    addProjectButton: {
      toasts: {
        addError: 'Failed to add project',
        initError: 'Failed to initialize repository',
        initialized: 'Git repository initialized'
      }
    },
    languageIcon: {
      customProjectIcon: 'Custom project icon'
    },
    spaces: {
      allProjects: 'All projects',
      createSpace: 'Create space',
      menu: {
        rename: 'Rename',
        changeIcon: 'Change Icon',
        delete: 'Delete'
      },
      dialogs: {
        createTitle: 'Create Space',
        createDescription: 'Organize your projects into spaces.',
        editTitle: 'Edit Space',
        editDescription: 'Update the space name or icon.',
        fields: {
          name: 'Name',
          icon: 'Icon'
        },
        namePlaceholder: 'e.g. Work, Side Projects',
        cancel: 'Cancel',
        create: 'Create',
        save: 'Save'
      },
      iconPicker: {
        search: 'Search icons...',
        noMatches: 'No icons match'
      }
    },
    mainPane: {
      welcomeTitle: 'Welcome to Xuanpu',
      welcomeDescription: 'Select a project or worktree to get started.',
      loadingSessions: 'Loading sessions...',
      noActiveSessionTitle: 'No active session',
      noActiveSessionDescription: 'Click the + button above to create a new session.'
    },
    agentPicker: {
      title: 'Choose Your AI Agent',
      description:
        'Multiple AI agents are installed. Choose which one to use as the default for new sessions. You can change this later in Settings.',
      agents: {
        opencode: {
          title: 'OpenCode',
          description: 'Open-source AI coding agent'
        },
        claude: {
          title: 'Claude Code',
          description: "Anthropic's coding assistant"
        },
        codex: {
          title: 'Codex',
          description: "OpenAI's coding agent"
        }
      }
    },
    onboardingWizard: {
      title: 'Developer Readiness',
      subtitle:
        'Check your environment, pick a default agent, and make the first run feel clean for your team.',
      headerTitle: 'First-launch setup',
      headerDescription:
        'Xuanpu checks the local toolchain and helps you choose a sensible default.',
      steps: {
        inspect: '1. Check environment',
        inspectDescription: 'Verify the machine is ready for local AI workflows.',
        choose: '2. Choose default agent',
        chooseDescription: 'Pick the provider new sessions should use by default.'
      },
      summary: {
        environmentReady: 'Environment',
        agentReady: 'Ready agents',
        detectedAgents: 'Installed CLIs',
        selected: 'Selection',
        pending: 'Pending selection',
        pendingDescription: 'Choose a ready agent, or continue in Terminal mode for now.'
      },
      badges: {
        ready: 'Ready',
        warning: 'Needs attention',
        missing: 'Not installed',
        recommended: 'Recommended',
        selected: 'Selected'
      },
      actions: {
        refresh: 'Re-check',
        retry: 'Try again',
        back: 'Back',
        next: 'Next',
        useTerminal: 'Use Terminal mode',
        openDocs: 'Open docs',
        runInTerminal: 'Open in Terminal',
        copyCommand: 'Copy command',
        quit: 'Quit app',
        start: 'Start with this setup'
      },
      loading: {
        title: 'Checking your local setup',
        description: 'Verifying core tools, installed CLIs, and login state.'
      },
      error: {
        title: 'The environment check could not complete',
        description: 'Retry the check, or continue with Terminal mode as a fallback.'
      },
      environment: {
        title: 'Core tools',
        description: 'These checks help your teammates land in a working setup faster.',
        git: {
          title: 'Git',
          ready: 'Detected {version}',
          missing: 'Required for cloning, branches, and diffs.'
        },
        node: {
          title: 'Node.js',
          ready: 'Detected {version}',
          outdated: 'Detected {version}. Node 18+ is recommended.',
          missing: 'Needed to install Claude Code or Codex.'
        },
        homebrew: {
          title: 'Homebrew',
          ready: 'Detected {version}',
          missing: 'Recommended on macOS for one-command installs.'
        },
        xcodeCli: {
          title: 'Xcode Command Line Tools',
          ready: 'Installed',
          missing: 'Recommended for Git and common local toolchains on macOS.'
        }
      },
      agents: {
        title: 'Available agents',
        description: 'Choose a native agent when it is ready, or fall back to Terminal mode.',
        claudeCode: {
          title: 'Claude Code',
          description: "Anthropic's local coding agent with strong default planning workflow.",
          ready: 'Installed and login credentials were detected.',
          loginRequired: 'Installed, but you need to finish the Claude login flow first.',
          authUnknown: 'Installed, but Xuanpu could not confirm the current login state.',
          missing: 'Claude Code is not installed yet.'
        },
        codex: {
          title: 'Codex',
          description: "OpenAI's local coding agent for terminal-first development.",
          ready: 'Installed and ready to use.',
          loginRequired: 'Installed, but Codex needs to be authenticated first.',
          authUnknown: 'Installed. Xuanpu could not verify auth, but you can still choose it.',
          missing: 'Codex is not installed yet.'
        },
        opencode: {
          title: 'OpenCode',
          description: 'Open-source coding agent with flexible provider routing.',
          ready: 'Installed. Provider access is finalized when you start a session.',
          loginRequired: 'Installed, but provider setup still needs attention.',
          authUnknown: 'Installed. Provider access will be checked inside the first session.',
          missing: 'OpenCode is not installed yet.'
        },
        terminal: {
          title: 'Terminal mode',
          description: 'Use Xuanpu as a project workspace first, then connect an agent later.',
          detail:
            'Terminal mode skips native agent setup for now and still gives you projects, worktrees, and the integrated terminal.'
        }
      },
      helper: {
        selectedReady: 'New sessions will use {agent} by default after you continue.',
        fallbackTitle: 'Fallback path',
        installTitle: 'Install guide',
        loginTitle: 'Login guide',
        selectedTitle: 'Current choice',
        whyTitle: 'Notes',
        recommendedDescription:
          'Xuanpu recommends {agent} because it is the best fit among the tools detected on this machine.',
        terminalDescription:
          'Terminal mode is a safe fallback. You can switch to Claude Code, Codex, or OpenCode later in Settings.',
        commandLabel: 'Suggested command',
        installDescription: 'Install {agent}, then run the check again.',
        loginDescription: 'Complete the login flow for {agent}, then run the check again.',
        environmentReady: 'Core environment is ready. Continue to choose the default agent.',
        environmentNeedsAttention:
          '{count} environment item(s) still need attention, but you can continue.',
        agentReadyDescription: '{agent} is ready. You can set it as the default now.',
        agentNotReady: 'Not selectable yet. Open the guidance below to finish setup.',
        authUnknownDescription:
          'Xuanpu could not verify the current auth state for {agent}, but you can already select it if you want to proceed.',
        loginHintClaude: 'Launch Claude Code and follow the interactive sign-in flow.',
        loginHintCodex: 'Run the login command and complete the ChatGPT or API-key authentication flow.',
        loginHintOpencode:
          'Launch OpenCode, then finish provider setup from the interactive session.'
      },
      toasts: {
        commandCopied: 'Command copied to clipboard',
        docsOpened: 'Opened the official documentation',
        terminalOpened: 'Opened the command in the system terminal',
        actionFailed: 'Action failed',
        selectedAgentRequired: 'Select a ready agent, or continue with Terminal mode.'
      }
    },
    sessionView: {
      compacting: 'Compressing context...',
      loading: {
        title: 'Connecting to session...',
        subtitle: 'This may take a moment'
      },
      error: {
        title: 'Connection Error',
        retry: 'Retry Connection',
        fallback: 'Failed to connect to session',
        connectOpencode: 'Failed to connect to OpenCode',
        connectSession: 'Failed to connect to session',
        connectGeneric: 'Failed to connect',
        sessionNotFound: 'Session not found'
      },
      empty: {
        title: 'Start a conversation',
        subtitle: 'Type a message below to begin',
        connectingOpencode: 'Connecting to OpenCode...',
        noWorktree: 'No worktree selected'
      },
      revert: {
        summarySingular: '1 message reverted',
        summaryPlural: '{count} messages reverted',
        restore: '/redo to restore'
      },
      sessionError: {
        title: 'Session error'
      },
      retry: {
        withCountdown: 'Retrying in {seconds}s (attempt {attempt})',
        withoutCountdown: 'Retrying (attempt {attempt})'
      },
      composer: {
        waitingPermissionResponse: 'Waiting for permission response...',
        waitingQuestionResponse: 'Waiting for your answer...',
        waitingCommandApprovalResponse: 'Waiting for command approval response...',
        planFeedbackPlaceholder: 'Send feedback to revise the plan...',
        messagePlaceholder: 'Type your message...',
        blockedByQuestionTitle: 'Answer the current question to continue',
        blockedByPermissionTitle: 'Respond to the current permission request',
        blockedByCommandApprovalTitle: 'Review the current command approval request',
        blockedHint: 'The chat box will resume after this interaction is resolved.',
        inputAriaLabel: 'Message input',
        planFeedbackHint: 'Enter to send feedback to revise the plan',
        planModeLabel: 'Plan Mode',
        activatePlanMode: 'Enter Plan',
        returnToBuildMode: 'Back to Build',
        changeVariantHint: '{shortcut} to change variant, Shift+Enter for new line',
        stopStreaming: 'Stop streaming',
        sendFeedback: 'Send feedback',
        sendFeedbackTitle: 'Send feedback to revise the plan',
        queueMessage: 'Queue message',
        sendMessage: 'Send message'
      },
      costPill: {
        title: 'Session Cost',
        totalCost: 'Total Cost',
        totalTokens: 'Total Tokens',
        input: 'Input',
        output: 'Output',
        cacheWrite: 'Cache Write',
        cacheRead: 'Cache Read',
        model: 'Model',
        duration: 'Duration',
        partialData: 'Some historical data could not be synchronized yet.'
      },
      connection: {
        disconnectedPlaceholder:
          'OpenCode is not connected. Please ensure a worktree is selected and the connection is established.'
      },
      completion: {
        alt: 'bee',
        defaultWord: 'Worked',
        forDuration: '{word} for {duration}'
      },
      toasts: {
        maxAttachmentsReached: 'Maximum {count} attachments reached',
        partialAttachments: 'Only {attached} of {total} files attached (maximum {count})',
        refreshResponseError: 'Failed to refresh response',
        followUpPromptError: 'Failed to send follow-up prompt',
        reviewPromptError: 'Failed to send review prompt',
        answerError: 'Failed to send answer',
        dismissQuestionError: 'Failed to dismiss question',
        permissionReplyError: 'Failed to send permission reply',
        commandApprovalReplyError: 'Failed to send command approval reply',
        notConnected: 'OpenCode is not connected',
        nothingToUndo: 'Nothing to undo',
        redoUnsupported: 'Redo is not supported for this session type',
        nothingToRedo: 'Nothing to redo',
        undoRedoRefreshFailed: 'Undo/redo completed, but refresh failed',
        undoFailed: 'Undo failed',
        redoFailed: 'Redo failed',
        askMissingQuestion: 'Please provide a question after /ask',
        questionError: 'Failed to send question',
        commandError: 'Failed to send command',
        messageToAiError: 'Failed to send message to AI',
        messageError: 'Failed to send message',
        forkNotReady: 'Session is not ready to fork yet',
        forkNoWorktree: 'Session has no worktree to fork into',
        forkMessageNotFound: 'Could not locate the selected message',
        forkFailed: 'Failed to fork session',
        noPendingPlanApproval: 'No pending plan approval found',
        planApproveFailed: 'Plan approve failed: {error}',
        planApproveError: 'Plan approve error: {error}',
        planRejectFailed: 'Plan reject failed: {error}',
        planRejectError: 'Plan reject error: {error}',
        noAssistantPlanToHandoff: 'No assistant plan message to hand off',
        startHandoffSessionError: 'Could not start handoff session',
        createHandoffSessionError: 'Failed to create handoff session',
        noPlanContentToSupercharge: 'No plan content found to supercharge',
        currentWorktreeNotFound: 'Could not find current worktree',
        projectForWorktreeNotFound: 'Could not find project for worktree',
        duplicateWorktreeError: 'Failed to duplicate worktree',
        createSuperchargeSessionError: 'Failed to create supercharge session',
        startLocalSuperchargeSessionError: 'Could not start local supercharge session',
        createLocalSuperchargeSessionError: 'Failed to create local supercharge session'
      }
    },
    sessionTerminalView: {
      loading: 'Loading terminal...'
    },
    sessionHistory: {
      title: 'Session History',
      common: {
        untitled: 'Untitled Session',
        untitledShort: 'Untitled',
        archived: 'Archived'
      },
      date: {
        todayAt: 'Today at {time}',
        yesterdayAt: 'Yesterday at {time}'
      },
      actions: {
        loadSession: 'Load Session'
      },
      search: {
        placeholder: 'Search title, project, or worktree...',
        hint: 'Keyword search matches session metadata (title, project, and worktree) only.'
      },
      filters: {
        project: 'Project',
        worktree: 'Worktree',
        allProjects: 'All Projects',
        allWorktrees: 'All Worktrees',
        dateRange: 'Date range',
        anyTime: 'Any time',
        from: 'From',
        to: 'To',
        more: 'More',
        includeArchived: 'Include archived worktrees',
        clear: 'Clear filters'
      },
      empty: {
        title: 'No sessions found',
        filtered: 'Try adjusting your search filters to find more sessions.',
        default: 'Start working in a worktree to create your first session.'
      },
      preview: {
        archivedWorktree: "This session's worktree has been archived",
        created: 'Created {date}',
        updated: 'Updated {date}',
        messagesTitle: 'Messages Preview',
        noMessages: 'No messages in this session',
        moreMessages: '...and more messages'
      },
      results: {
        count: '{count} {label} found',
        sessionSingular: 'session',
        sessionPlural: 'sessions'
      },
      toasts: {
        loaded: 'Loaded session "{name}"',
        loadError: 'Failed to load session',
        readOnlyArchived: 'This session is from an archived worktree. Opening in read-only mode.'
      }
    },
    sessionTabs: {
      common: {
        untitled: 'Untitled',
        staged: 'staged',
        unstaged: 'unstaged'
      },
      menu: {
        close: 'Close',
        closeOthers: 'Close Others',
        closeToRight: 'Close Others to the Right',
        copyRelativePath: 'Copy Relative Path',
        copyAbsolutePath: 'Copy Absolute Path'
      },
      actions: {
        createSession: 'Create new session (right-click for options)',
        newOpenCode: 'New OpenCode Session',
        newClaudeCode: 'New Claude Code Session',
        newCodex: 'New Codex Session',
        newTerminal: 'New Terminal'
      },
      empty: {
        noSessions: 'No sessions yet. Click + to create one.'
      },
      context: {
        title: 'Worktree Context',
        label: 'Context'
      },
      toasts: {
        copied: 'Copied to clipboard'
      },
      errors: {
        createSession: 'Failed to create session',
        closeSession: 'Failed to close session',
        renameSession: 'Failed to rename session'
      }
    },
    slashCommandPopover: {
      loading: 'Loading commands...',
      noMatches: 'No matching commands',
      badges: {
        plan: 'plan',
        build: 'build',
        builtIn: 'built-in'
      },
      descriptions: {
        undo: 'Undo the last message and file changes',
        redo: 'Redo the last undone message and file changes',
        clear: 'Close current tab and open a new one',
        ask: 'Ask a question without making code changes'
      }
    },
    planReadyFab: {
      labels: {
        handoff: 'Handoff',
        superchargeLocal: 'Supercharge locally',
        supercharge: 'Supercharge',
        implement: 'Implement'
      },
      aria: {
        handoff: 'Handoff plan',
        superchargeLocal: 'Supercharge plan locally',
        supercharge: 'Supercharge plan',
        implement: 'Implement plan'
      }
    },
    scrollToBottomFab: {
      ariaLabel: 'Scroll to bottom'
    },
    forkMessageButton: {
      ariaLabel: 'Fork message'
    },
    leftSidebar: {
      ariaLabel: 'Projects and worktrees'
    },
    rightSidebar: {
      ariaLabel: 'File sidebar',
      fileSidebarError: 'File sidebar error'
    },
    reasoningBlock: {
      thinking: 'Thinking...'
    },
    queuedIndicator: {
      label: '{count} message(s) queued'
    },
    queuedMessageBubble: {
      badge: 'QUEUED'
    },
    toolCallContextMenu: {
      actions: {
        copyDetails: 'Copy Details',
        inspect: 'Inspect Tool Call'
      },
      toasts: {
        nothingToCopy: 'Nothing to copy',
        copied: 'Copied to clipboard',
        copyError: 'Failed to copy'
      }
    },
    toolCallDebugModal: {
      title: 'Tool Call Inspector',
      tabs: {
        input: 'Input',
        output: 'Output'
      },
      actions: {
        copied: 'Copied',
        copy: 'Copy {label}'
      },
      toasts: {
        copied: '{label} copied to clipboard',
        copyError: 'Failed to copy'
      },
      status: {
        pending: 'pending',
        running: 'running',
        success: 'success',
        error: 'error'
      }
    },
    runTab: {
      empty: {
        noWorktree: 'Select a worktree to run scripts',
        noOutput: 'No run output yet. Press ⌘R or click Run to start.',
        setupScript: 'Setup run script'
      },
      status: {
        running: 'Running',
        stopped: 'Stopped'
      },
      actions: {
        clear: 'Clear',
        stop: 'Stop',
        restart: 'Restart',
        run: 'Run'
      }
    },
    errorBoundary: {
      title: 'Something went wrong',
      componentPrefix: 'Error in:',
      unexpected: 'An unexpected error occurred',
      tryAgain: 'Try Again',
      reloadApp: 'Reload App',
      copied: 'Copied',
      copyError: 'Copy Error',
      developerDetails: 'Developer Details'
    },
    worktreeContext: {
      title: 'Worktree Context',
      unsaved: 'Unsaved changes',
      preview: 'Preview',
      edit: 'Edit',
      close: 'Close',
      save: 'Save Context',
      empty:
        'No worktree context set. Click Edit to add context that will be injected into AI sessions.',
      confirmDiscard: 'You have unsaved changes. Discard them?',
      placeholder:
        'Enter worktree context here. This markdown will be injected into the first prompt of each new AI session.\n\nExample:\n## Feature: User Authentication\n- Working on login/signup flow\n- Backend API at /api/auth\n- Using JWT tokens',
      toasts: {
        loadError: 'Failed to load worktree context',
        saved: 'Context saved',
        saveError: 'Failed to save context'
      }
    },
    codexFastToggle: {
      label: 'Fast',
      title: 'Fast Mode',
      description: 'Fast mode consumes 2X the usage from your plan.',
      cancel: 'Cancel',
      accept: 'Accept',
      enabled: 'enabled',
      disabled: 'disabled',
      ariaLabel: 'Fast mode {state}'
    },
    sessionTaskTracker: {
      title: '{total} tasks, {completed} completed',
      pending: '{count} pending',
      cancelled: '{count} cancelled',
      allDone: 'All tasks completed',
      more: '{count} more tasks',
      expand: 'Expand tasks',
      collapse: 'Collapse tasks'
    },
    toolCard: {
      labels: {
        bash: 'Bash',
        tasks: 'Tasks',
        read: 'Read',
        write: 'Write',
        edit: 'Edit',
        search: 'Search',
        findFiles: 'Find files',
        skill: 'Skill',
        question: 'Question',
        agent: 'Agent',
        plan: 'Plan',
        fetch: 'Fetch',
        lsp: 'LSP',
        figma: 'Figma'
      },
      actions: {
        view: 'View',
        hide: 'Hide'
      },
      fallback: {
        unknown: 'unknown'
      },
      summary: {
        completed: '{completed}/{total} completed',
        active: '{count} active',
        lines: '{count} lines',
        more: '+{count} more',
        inPath: 'in {path}',
        questions: '{count} questions',
        accepted: 'accepted',
        rejected: 'rejected',
        review: 'review',
        implementPlan: 'Implement the plan'
      }
    },
    questionPrompt: {
      custom: {
        typeOwn: 'Type your own answer',
        placeholder: 'Type your answer...'
      },
      actions: {
        submit: 'Submit',
        submitAll: 'Submit All',
        cancel: 'Cancel',
        back: 'Back',
        next: 'Next',
        dismiss: 'Dismiss',
        sending: 'Sending...'
      }
    },
    bottomPanel: {
      tabs: {
        setup: 'Initialize',
        run: 'Run',
        terminal: 'Terminal'
      },
      chrome: {
        openTitle: 'Open {url} in browser (right-click to configure)',
        customCommand: 'Custom Chrome Command',
        placeholderHelp: 'Use {url} as placeholder. Leave empty for default browser.',
        cancel: 'Cancel',
        save: 'Save',
        saved: 'Chrome command saved'
      }
    },
    fileContextMenu: {
      viewChanges: 'View Changes',
      stageFile: 'Stage File',
      unstageFile: 'Unstage File',
      discardChanges: 'Discard Changes',
      confirmDiscard: 'Click again to confirm',
      addToGitignore: 'Add to .gitignore',
      openInEditor: 'Open in Editor',
      openInFileManager: 'Open in {manager}',
      revealInFinder: 'Reveal in Finder',
      revealInExplorer: 'Show in Explorer',
      copyPath: 'Copy Path',
      copyRelativePath: 'Copy Relative Path'
    },
    diffUi: {
      status: {
        compareBranch: 'vs {branch}',
        newFile: 'New file',
        staged: 'Staged',
        unstaged: 'Unstaged',
        stagedChanges: 'Staged changes',
        unstagedChanges: 'Unstaged changes'
      },
      actions: {
        split: 'Split',
        unified: 'Unified',
        copy: 'Copy',
        moreContext: 'More context',
        previousHunk: 'Previous hunk (Alt+Up)',
        nextHunk: 'Next hunk (Alt+Down)',
        previousChange: 'Previous change (Alt+Up)',
        nextChange: 'Next change (Alt+Down)',
        showMoreContext: 'Show more context',
        switchToSplitView: 'Switch to split view',
        switchToUnifiedView: 'Switch to unified view',
        switchToInlineView: 'Switch to inline view',
        switchToSideBySideView: 'Switch to side-by-side view',
        copyToClipboard: 'Copy to clipboard',
        closeWithEsc: 'Close (Esc)',
        stageChange: 'Stage this change',
        unstageChange: 'Unstage this change',
        revertChange: 'Revert this change'
      },
      viewer: {
        noChanges: 'No changes',
        parseError: 'Failed to parse diff',
        ariaLabel: 'File diff viewer'
      },
      toasts: {
        diffCopied: 'Diff copied to clipboard',
        fileContentCopied: 'File content copied to clipboard',
        hunkStaged: 'Hunk staged',
        hunkUnstaged: 'Hunk unstaged',
        hunkReverted: 'Hunk reverted'
      },
      errors: {
        loadDiff: 'Failed to load diff',
        loadFileContent: 'Failed to load file content',
        loadImageDiff: 'Failed to load image diff',
        loadHeadVersion: 'Failed to load HEAD version',
        loadStagedVersion: 'Failed to load staged version',
        loadOriginalVersion: 'Failed to load original version',
        loadDiffContent: 'Failed to load diff content',
        stageHunk: 'Failed to stage hunk',
        unstageHunk: 'Failed to unstage hunk',
        revertHunk: 'Failed to revert hunk'
      },
      image: {
        before: 'Before',
        after: 'After'
      }
    },
    dialog: {
      close: 'Close'
    },
    permissionPrompt: {
      header: {
        required: 'Permission Required',
        alwaysAllowFallback: 'Always allow this type of action'
      },
      types: {
        bash: 'Run Command',
        edit: 'Edit File',
        read: 'Read File',
        search: 'Search Files',
        webAccess: 'Web Access',
        externalDirectory: 'External Directory',
        task: 'Run Sub-task'
      },
      actions: {
        sending: 'Sending...',
        allowOnce: 'Allow once',
        allowAlways: 'Allow always',
        deny: 'Deny'
      }
    },
    commandApprovalPrompt: {
      header: {
        required: 'Command Approval Required',
        tool: 'Tool: {name}'
      },
      types: {
        bash: 'Execute Command',
        edit: 'Edit File',
        write: 'Write File',
        read: 'Read File',
        search: 'Search Files',
        web: 'Web Access',
        task: 'Run Sub-task',
        skill: 'Execute Skill',
        notebookEdit: 'Edit Notebook'
      },
      subCommands: {
        alreadyAllowed: 'Already allowed'
      },
      patternPicker: {
        allowPerCommand: 'Choose patterns to always allow (one per command):',
        allowOne: 'Choose pattern to always allow:',
        blockOne: 'Choose pattern to always block:',
        saving: 'Saving...',
        cancel: 'Cancel'
      },
      actions: {
        sending: 'Sending...',
        allowOnce: 'Allow once',
        allowAlways: 'Allow always',
        allowAlwaysTitle: 'Always allow this command pattern',
        blockAlways: 'Block always',
        blockAlwaysTitle: 'Always block this command pattern',
        deny: 'Deny'
      }
    },
    prReview: {
      viewer: {
        loading: 'Loading review comments...',
        retry: 'Retry',
        empty: 'No review comments on this PR',
        refresh: 'Refresh comments',
        allHidden: 'All comments hidden by filters',
        selectedCount: '{count} selected',
        selectAll: 'Select all',
        deselect: 'Deselect',
        addToChat: 'Add to chat',
        reviewer: {
          show: "Show {login}'s comments",
          hide: "Hide {login}'s comments"
        }
      },
      store: {
        fetchError: 'Failed to fetch comments',
        unknownReviewer: 'unknown reviewer',
        unknownPath: 'unknown'
      },
      commentCard: {
        copied: 'Raw comment HTML copied',
        outdated: 'old',
        copyRawHtml: 'Copy raw HTML'
      }
    },
    toolViews: {
      common: {
        showLess: 'Show less',
        showAllLines: 'Show all {count} lines'
      },
      grep: {
        in: 'in',
        matchCount: '{count} {label}',
        matchSingular: 'match',
        matchPlural: 'matches',
        noMatches: 'No matches found',
        showAllResults: 'Show all {count} results'
      },
      read: {
        linesRange: 'Lines {start}-{end}',
        fromLine: 'From line {start}',
        firstLines: 'First {count} lines'
      },
      fileChange: {
        add: 'Add',
        delete: 'Delete',
        update: 'Update',
        moreLines: '... {count} more lines',
        noDiffContent: 'No diff content',
        noChanges: 'No file changes'
      },
      edit: {
        lineCount: '{count} {label}',
        lineSingular: 'line',
        linePlural: 'lines',
        moreRemoved: '... {count} more removed',
        moreAdded: '... {count} more added',
        noChanges: 'No changes'
      },
      fallback: {
        todo: 'TODO',
        error: 'Error',
        input: 'Input',
        output: 'Output',
        note: 'No custom renderer - showing raw data'
      },
      skill: {
        loading: 'Loading skill...'
      },
      exitPlan: {
        empty: 'No plan content available.'
      },
      todo: {
        empty: 'No tasks'
      },
      webFetch: {
        bytesSingular: '{count} byte',
        bytesPlural: '{count} bytes',
        kb: '{value} KB',
        mb: '{value} MB'
      },
      lsp: {
        noHover: 'No hover information',
        noResults: 'No results found',
        noDiagnostics: 'No diagnostics found',
        unknown: 'unknown',
        showAll: 'Show all {count} {label}',
        labels: {
          locations: 'locations',
          calls: 'calls',
          symbols: 'symbols',
          diagnostics: 'diagnostics'
        },
        operations: {
          definition: 'definition',
          hover: 'hover',
          references: 'references',
          symbols: 'symbols',
          workspaceSymbols: 'workspace symbols',
          implementation: 'implementation',
          callers: 'callers',
          callees: 'callees',
          diagnostics: 'diagnostics'
        },
        symbolKinds: {
          file: 'file',
          module: 'module',
          namespace: 'namespace',
          package: 'package',
          class: 'class',
          method: 'method',
          property: 'property',
          field: 'field',
          constructor: 'constructor',
          enum: 'enum',
          interface: 'interface',
          function: 'function',
          variable: 'variable',
          constant: 'constant',
          string: 'string',
          number: 'number',
          boolean: 'boolean',
          array: 'array',
          object: 'object',
          key: 'key',
          null: 'null',
          enumMember: 'enum member',
          struct: 'struct',
          event: 'event',
          operator: 'operator',
          typeParam: 'type param'
        }
      },
      task: {
        defaultTitle: 'Sub-agent',
        prompt: 'Prompt'
      }
    },
    contextIndicator: {
      title: 'Context Window',
      summary: {
        withLimit: '{used} / {limit} tokens ({percent}%)',
        noLimit: '{used} tokens (limit unavailable)'
      },
      labels: {
        input: 'Input',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write'
      },
      generated: {
        title: 'Generated (not in context)',
        output: 'Output',
        reasoning: 'Reasoning'
      },
      cost: {
        session: 'Session cost: {cost}'
      }
    },
    helpOverlay: {
      title: 'Keyboard Shortcuts',
      mode: {
        normal: 'NORMAL',
        insert: 'INSERT'
      },
      sections: {
        vimNavigation: 'Vim Navigation',
        panelShortcuts: 'Panel Shortcuts',
        actionShortcuts: 'Action Shortcuts',
        sidebarHints: 'Sidebar Hints',
        sessionHints: 'Session Hints',
        systemShortcuts: 'System Shortcuts'
      },
      rows: {
        navigateWorktrees: 'Navigate worktrees',
        navigateSessionTabs: 'Navigate session tabs',
        filterProjectsInsert: 'Filter projects (insert mode)',
        returnToNormalMode: 'Return to normal mode',
        toggleHelp: 'Toggle this help',
        prevNextFileTab: 'Prev / Next file tab'
      },
      panels: {
        changes: 'Changes',
        files: 'Files',
        diffs: 'Diffs',
        setup: 'Setup',
        run: 'Run',
        terminal: 'Terminal'
      },
      actions: {
        review: 'Review',
        pr: 'PR',
        mergePr: 'Merge PR',
        archive: 'Archive'
      },
      dynamic: {
        pinnedPrefix: '[pin] {name}',
        connectionFallback: 'Connection'
      }
    },
    keyboardShortcuts: {
      items: {
        sessionNew: 'New Session',
        sessionClose: 'Close Session',
        sessionModeToggle: 'Toggle Build/Plan Mode',
        projectRun: 'Run Project',
        modelCycleVariant: 'Cycle Model Variant',
        navFileSearch: 'Search Files',
        navCommandPalette: 'Open Command Palette',
        navSessionHistory: 'Open Session History',
        navNewWorktree: 'New Worktree',
        gitCommit: 'Focus Commit Form',
        gitPush: 'Push to Remote',
        gitPull: 'Pull from Remote',
        navFilterProjects: 'Filter Projects',
        sidebarToggleLeft: 'Toggle Left Sidebar',
        sidebarToggleRight: 'Toggle Right Sidebar',
        focusLeftSidebar: 'Focus Left Sidebar',
        focusMainPane: 'Focus Main Pane',
        settingsOpen: 'Open Settings'
      }
    },
    connectionStore: {
      toasts: {
        unknownError: 'Unknown error',
        createError: 'Failed to create connection: {error}',
        createSuccess: 'Connection "{name}" created',
        deleteError: 'Failed to delete connection',
        deleteErrorWithReason: 'Failed to delete connection: {error}',
        deleteSuccess: 'Connection deleted',
        addMemberError: 'Failed to add member: {error}',
        removeMemberError: 'Failed to remove member: {error}',
        notFound: 'Connection not found',
        updateSuccess: 'Connection updated',
        updateError: 'Failed to update connection: {error}',
        renameError: 'Failed to rename connection',
        renameErrorWithReason: 'Failed to rename connection: {error}'
      }
    },
    pinnedStore: {
      toasts: {
        pinConnectionError: 'Failed to pin connection',
        unpinConnectionError: 'Failed to unpin connection'
      }
    },
    sessionStore: {
      errors: {
        createConnectionSession: 'Failed to create connection session'
      }
    },
    commandPalette: {
      ariaLabel: 'Command palette',
      commandLabel: 'Command palette',
      backAriaLabel: 'Go back',
      placeholderRoot: 'Type a command or search...',
      placeholderIn: 'Search in {label}...',
      empty: 'No commands found.',
      results: 'Results',
      hints: {
        navigate: 'navigate',
        select: 'select',
        close: 'close',
        goBack: 'go back',
        or: 'or'
      },
      categories: {
        recent: 'Recent',
        navigation: 'Navigation',
        action: 'Actions',
        git: 'Git',
        settings: 'Settings',
        file: 'File'
      }
    },
    sidebar: {
      projects: 'Projects',
      filterProjects: 'Filter projects...',
      filterPopover: {
        noMatchingCommands: 'No matching commands',
        noMatchingLanguages: 'No matching languages'
      },
      recentToggleTitle: 'Toggle recent activity',
      sortProjectsTitle: 'Sort by last message',
      addProjectTitle: 'Add Project',
      connectionMode: {
        selectWorktrees: 'Select worktrees',
        cancel: 'Cancel',
        connect: 'Connect',
        connecting: 'Connecting...'
      }
    },
    recent: {
      title: 'Recent',
      connectionFallback: 'Connection',
      status: {
        answering: 'Answer questions',
        commandApproval: 'Approve command',
        permission: 'Permission',
        planning: 'Planning',
        working: 'Working',
        planReady: 'Plan ready',
        ready: 'Ready'
      }
    },
    dialogs: {
      archiveConfirm: {
        title: 'Uncommitted Changes',
        description: '{worktreeName} has uncommitted changes that will be permanently lost.',
        binary: 'binary',
        noChanges: 'no changes',
        moreFiles: '+{count} more {label}',
        fileSingular: 'file',
        filePlural: 'files',
        cancel: 'Cancel',
        confirm: 'Archive Anyway'
      },
      gitInit: {
        title: 'Not a Git Repository',
        selectedFolder: 'The selected folder is not a Git repository:',
        question: 'Would you like to initialize a new Git repository?',
        cancel: 'Cancel',
        confirm: 'Initialize Repository'
      },
      connect: {
        title: 'Connect Worktrees',
        description: 'Select worktrees from other projects to connect into a shared workspace.',
        existingConnections: 'Existing Connections',
        addToExisting: 'Add to Existing Connection',
        filterPlaceholder: 'Filter worktrees...',
        noWorktrees: 'No worktrees from other projects available.',
        noWorktreesHint: 'Add another project to Xuanpu first.',
        noMatches: 'No worktrees match your filter',
        selectedCount: '{count} {label} selected',
        selectedNone: 'Select worktrees to connect',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktrees',
        connect: 'Connect',
        connecting: 'Connecting...'
      },
      manageConnectionWorktrees: {
        title: 'Connection Worktrees',
        description: 'Manage which worktrees are part of this connection.',
        filterPlaceholder: 'Filter worktrees...',
        noWorktrees: 'No active worktrees found.',
        noMatches: 'No worktrees match your filter',
        selectedNone: 'Select at least 1 worktree',
        selectedCount: '{count} {label} selected',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktrees',
        save: 'Save',
        saving: 'Saving...'
      },
      addAttachment: {
        title: 'Add Attachment',
        placeholder: 'Paste a Jira or Figma URL',
        detected: {
          jira: 'Jira ticket',
          figma: 'Figma file'
        },
        unsupportedUrl: 'Unsupported URL',
        confirm: 'Add',
        toasts: {
          added: 'Attached {type}: {label}',
          addError: 'Failed to add attachment'
        }
      },
      projectSettings: {
        title: 'Project Settings',
        icon: {
          label: 'Project Icon',
          description: 'Custom icon displayed in the sidebar. Supports SVG, PNG, JPG, and WebP.',
          change: 'Change',
          changing: 'Picking...',
          clear: 'Clear',
          pickError: 'Failed to pick icon',
          removeError: 'Failed to remove icon'
        },
        autoAssignPort: {
          label: 'Auto-assign Port',
          description:
            'Assign a unique port to each worktree and inject PORT into run/setup scripts. Ports start at 3011.'
        },
        setupScript: {
          label: 'Setup Script',
          description:
            'Commands to run when a new worktree is initialized. Each line is a separate command.',
          placeholder: 'pnpm install\npnpm run build'
        },
        runScript: {
          label: 'Run Script',
          description: 'Commands triggered by ⌘R. Press ⌘R again while running to stop.',
          placeholder: 'pnpm run dev'
        },
        archiveScript: {
          label: 'Archive Script',
          description: "Commands to run before worktree archival. Failures won't block archival.",
          placeholder: 'pnpm run clean'
        },
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving...',
        saveSuccess: 'Project settings saved',
        saveError: 'Failed to save project settings',
        modelProfile: 'Model Profile',
        modelProfileDescription: 'Select a model profile for this project'
      },
      worktreeSettings: {
        title: 'Workspace Settings',
        modelProfile: 'Model Profile',
        modelProfileDescription: 'Override the model profile for this workspace. Falls back to the project profile or global default.',
        save: 'Save',
        saving: 'Saving...',
        cancel: 'Cancel',
        saveSuccess: 'Workspace settings saved',
        saveError: 'Failed to save workspace settings',
        profileSynced: 'Model profile updated — next message will use new settings'
      },
      branchPicker: {
        title: 'New Workspace',
        description: 'Select a branch or pull request to create a new workspace from.',
        tabs: {
          branches: 'Branches',
          prs: 'PRs'
        },
        filterBranches: 'Filter branches...',
        filterPRs: 'Filter pull requests...',
        loadingBranches: 'Loading branches...',
        noBranchesMatch: 'No branches match your filter',
        noBranches: 'No branches found',
        remote: 'remote',
        active: 'active',
        loadingPRs: 'Loading pull requests...',
        noPRsMatch: 'No pull requests match your filter',
        noPRs: 'No open pull requests',
        branchCount: '{count} {label}{match}',
        prCount: '{count} {label}{match}',
        branchSingular: 'branch',
        branchPlural: 'branches',
        prSingular: 'pull request',
        prPlural: 'pull requests',
        matching: ' matching "{query}"'
      }
    },
    header: {
      controls: {
        fixConflicts: 'Fix conflicts',
        fixingConflicts: 'Fixing conflicts...',
        archiveWorktreeTitle: 'Archive worktree',
        archive: 'Archive',
        archiving: 'Archiving...',
        mergePRTitle: 'Merge Pull Request',
        mergePR: 'Merge PR',
        merging: 'Merging...',
        reviewTitle: 'Review branch changes with AI',
        review: 'Review',
        noRemoteBranches: 'No remote branches',
        attached: 'Attached',
        loadingPRs: 'Loading PRs...',
        noOpenPRs: 'No open PRs found',
        detachPR: 'Detach PR',
        createPRTitle: 'Create Pull Request (right-click to attach existing)',
        attachExistingPR: 'Attach existing PR',
        sessionHistoryTitle: 'Session History (⌘K)',
        settingsTitle: 'Settings (⌘,)',
        showSidebar: 'Show sidebar',
        hideSidebar: 'Hide sidebar',
        merged: 'merged',
        closed: 'closed'
      },
      toasts: {
        loadPRsError: 'Failed to load PRs',
        noWorktreeSelected: 'No worktree selected',
        projectNotFound: 'Could not find project for worktree',
        createPRSessionError: 'Failed to create PR session',
        createReviewSessionError: 'Failed to create review session',
        prMergedSuccess: 'PR merged successfully',
        mergePRError: 'Failed to merge PR',
        mergePRErrorWithReason: 'Merge failed: {error}'
      },
      sessionNames: {
        pr: 'PR -> {branch}',
        review: 'Code Review - {branch} vs {target}',
        conflicts: 'Merge Conflicts - {branch}'
      }
    },
    modelSelector: {
      title: 'Select model',
      ariaLabel: 'Current model: {model}. Click to change model',
      loading: 'Loading...',
      filterPlaceholder: 'Filter models...',
      favorites: 'Favorites',
      empty: {
        filtered: 'No matching models',
        default: 'No models available'
      },
      toasts: {
        variant: 'Variant: {variant}'
      }
    },
    pinned: {
      title: 'Pinned',
      connectionFallback: 'Connection',
      connectionNamePlaceholder: 'Connection name',
      menu: {
        open: 'Open',
        detach: 'Detach',
        addAttachment: 'Add Attachment',
        editContext: 'Edit Context',
        worktreeSettings: 'Workspace Settings',
        openInTerminal: 'Open in Terminal',
        openInEditor: 'Open in Editor',
        openInFileManager: 'Open in {manager}',
        copyPath: 'Copy Path',
        pin: 'Pin',
        unpin: 'Unpin',
        connectTo: 'Connect to...',
        renameBranch: 'Rename Branch',
        duplicate: 'Duplicate',
        unbranch: 'Unbranch',
        keepBranch: 'Keep branch',
        archive: 'Archive',
        deleteBranch: 'Delete branch',
        removeWorktree: 'Remove Worktree',
        detachedHead: 'Detached HEAD',
        connectionWorktrees: 'Connection Worktrees',
        rename: 'Rename',
        delete: 'Delete'
      },
      status: {
        archiving: 'Archiving',
        answering: 'Answer questions',
        commandApproval: 'Approve command',
        permission: 'Permission',
        planning: 'Planning',
        working: 'Working',
        planReady: 'Plan ready',
        ready: 'Ready'
      },
      toasts: {
        attachmentRemoved: 'Attachment removed',
        attachmentRemoveError: 'Failed to remove attachment',
        invalidBranchName: 'Invalid branch name',
        branchRenamed: 'Branch renamed to {branch}',
        branchRenameError: 'Failed to rename branch',
        detachedCannotDuplicate: 'Detached HEAD worktrees cannot be duplicated',
        duplicatedTo: 'Duplicated to {name}',
        newBranch: 'new branch',
        duplicateError: 'Failed to duplicate worktree',
        archiveSuccess: 'Worktree "{name}" archived and branch deleted',
        archiveError: 'Failed to archive worktree: {error}',
        unbranchSuccess: 'Worktree "{name}" removed (branch preserved)',
        removeWorktreeSuccess: 'Worktree "{name}" removed',
        unbranchError: 'Failed to unbranch worktree: {error}',
        unknownError: 'Unknown error',
        openedInTerminal: 'Opened in Terminal',
        openInTerminalError: 'Failed to open in terminal',
        openInTerminalDescription: 'Make sure the worktree directory exists',
        openedInEditor: 'Opened in Editor',
        openInEditorError: 'Failed to open in editor',
        openInEditorDescription: 'Make sure VS Code is installed',
        pathCopied: 'Path copied to clipboard'
      }
    },
    projectItem: {
      menu: {
        editName: 'Edit Name',
        openInFileManager: 'Open in {manager}',
        copyPath: 'Copy Path',
        refreshLanguage: 'Refresh Language',
        refreshProject: 'Refresh Project',
        newWorkspaceFrom: 'New Workspace From...',
        projectSettings: 'Project Settings',
        assignToSpace: 'Assign to Space',
        removeFromHive: 'Remove from Xuanpu'
      },
      dialogs: {
        remove: {
          title: 'Remove project from Xuanpu?',
          description: 'This will remove {name} from Xuanpu.',
          unaffected: 'Your files on disk will not be affected.',
          cancel: 'Cancel',
          confirm: 'Remove'
        },
        noCommits: {
          title: 'Initial Commit Required',
          description:
            'Creating a first commit with the initial state is required for adding worktrees.',
          ok: 'OK'
        }
      },
      toasts: {
        renamedSuccess: 'Project renamed successfully',
        renamedError: 'Failed to rename project',
        removedSuccess: 'Project removed from Xuanpu',
        removedError: 'Failed to remove project',
        pathCopied: 'Path copied to clipboard',
        refreshed: 'Project refreshed',
        worktreeCreated: 'Worktree "{name}" created successfully',
        createWorktreeError: 'Failed to create worktree',
        createWorktreeErrorWithReason: 'Failed to create worktree: {error}',
        createWorktreeFromBranchError: 'Failed to create worktree from branch',
        createWorktreeFromBranchErrorWithReason: 'Failed to create worktree from branch: {error}'
      }
    }
  },
  'zh-CN': {
    settings: {
      title: '设置',
      sections: {
        appearance: '外观',
        general: '通用',
        models: '模型',
        editor: '编辑器',
        terminal: '终端',
        security: '安全',
        privacy: '隐私',
        usage: '使用统计',
        shortcuts: '快捷键',
        updates: '更新'
      },
      appearance: {
        title: '外观',
        description: '为应用选择主题。',
        darkThemes: '深色主题',
        lightThemes: '浅色主题'
      },
      general: {
        title: '通用',
        description: '基础应用设置',
        language: {
          label: '语言',
          description: '选择已接入翻译的界面语言。其余界面会逐步迁移到 i18n。',
          options: {
            en: 'English',
            zhCN: '简体中文'
          }
        },
        autoStartSession: {
          label: '自动启动会话',
          description: '当选中一个尚无会话的 worktree 时，自动创建新会话'
        },
        vimMode: {
          label: 'Vim 模式',
          description: '启用 Vim 风格键盘导航，包括 hints、hjkl 滚动和模式切换'
        },
        modelIcons: {
          label: '模型图标',
          description: '在 worktree 状态旁显示模型图标（Claude、OpenAI）'
        },
        modelProvider: {
          label: '显示模型提供方',
          description: '在模型选择器里显示提供方名称，例如 ANTHROPIC'
        },
        usageIndicator: {
          label: '显示用量指示器',
          description: '在项目下方显示 Claude API 用量条。关闭后会显示 spaces 标签页。'
        },
        aiProvider: {
          label: 'AI 提供方',
          description: '为新会话选择默认 AI 编码代理。已有会话会保留原来的 provider。',
          terminalHint: '打开终端窗口，由你手动运行 claude、aider、cursor 等任意 AI 工具'
        },
        stripAtMentions: {
          label: '发送前去掉文件提及中的 @',
          description: '通过文件选择器插入文件引用后，在发送前移除前缀 @ 符号'
        },
        branchNaming: {
          label: '分支命名',
          description: '为自动生成的 worktree 分支选择命名主题',
          options: {
            dogs: '狗',
            cats: '猫'
          }
        },
        resetAll: {
          label: '重置全部设置',
          description: '这会把所有设置、主题和快捷键恢复到默认值。',
          success: '所有设置已恢复默认值'
        }
      },
      editor: {
        title: '编辑器',
        description: '选择 “Open in Editor” 操作默认打开的编辑器',
        detecting: '正在检测已安装的编辑器...',
        notFound: '（未找到）',
        customCommand: {
          label: '自定义编辑器命令',
          description: '调用该命令时会把 worktree 路径作为参数传入。',
          optionLabel: '自定义命令'
        }
      },
      models: {
        title: '默认模型',
        description: '配置不同模式和命令默认使用的 AI 模型',
        priority: {
          title: '模型选择优先级：',
          worktree: 'Worktree 上次使用的模型（如果有）',
          mode: '模式专属默认模型（下方配置）',
          global: '全局默认模型',
          fallback: '系统兜底模型（Claude Opus 4.5）'
        },
        global: {
          label: '全局默认模型',
          fallbackDescription: '当未配置模式专属默认模型时使用的兜底模型',
          sessionDescription: '所有新会话默认使用的模型',
          clear: '清除'
        },
        build: {
          label: 'Build 模式默认模型',
          description: '新建 build 模式会话时使用的模型（常规编码）'
        },
        plan: {
          label: 'Plan 模式默认模型',
          description: '新建 plan 模式会话时使用的模型（设计与规划）'
        },
        ask: {
          label: '/ask 命令默认模型',
          description: '执行 /ask 命令进行快速提问时使用的模型'
        },
        useGlobal: '使用全局默认',
        profiles: {
          title: '模型配置',
          description: '创建带有自定义 API Key 和端点的命名配置，可分配到项目或 Worktree。',
          add: '添加配置',
          edit: '编辑配置',
          create: '创建配置',
          delete: '删除',
          deleteConfirm: '删除此配置？使用它的项目和 Worktree 将回退到全局默认配置。',
          setDefault: '设为默认',
          removeDefault: '取消默认',
          default: '默认',
          name: '名称',
          namePlaceholder: '如：个人、公司',
          provider: '提供商',
          apiKey: 'API Key',
          apiKeyPlaceholder: 'sk-ant-...',
          baseUrl: 'Base URL',
          baseUrlPlaceholder: 'https://api.anthropic.com（可选）',
          openaiApiKey: 'OpenAI API Key',
          openaiApiKeyPlaceholder: 'sk-...',
          openaiBaseUrl: 'OpenAI Base URL',
          openaiBaseUrlPlaceholder: 'https://api.openai.com/v1（可选）',
          codexConfigToml: '配置 (config.toml)',
          codexConfigTomlHint: '粘贴 ~/.codex/config.toml 内容，API key 通过 OPENAI_API_KEY 注入',
          modelId: '默认模型',
          modelIdPlaceholder: '如：claude-sonnet-4-20250514（可选）',
          advancedSettings: '高级设置（JSON）',
          noProfiles: '暂无配置，添加一个开始使用。',
          useGlobalDefault: '使用全局默认',
          useProjectDefault: '使用项目默认',
          none: '无'
        }
      },
      terminal: {
        embedded: {
          title: '内置终端',
          description: '选择内置终端面板使用的渲染引擎',
          xtermLabel: '内置（xterm.js）',
          xtermDescription: '跨平台终端模拟器，始终可用。',
          ghosttyLabel: 'Ghostty（原生）',
          ghosttyDescription: 'macOS 上的原生 Metal 渲染，需要安装 Ghostty。',
          macOnly: '（仅 macOS）',
          notAvailable: '（不可用）',
          info: 'Ghostty 通过 Metal 提供更原生的渲染性能。切换后端时终端会重启。颜色和光标样式会读取你的 Ghostty 配置。',
          fontSizeLabel: '字体大小',
          fontSizeUnit: 'pt（8-32）',
          fontSizeDescription: '内置 Ghostty 终端的字体大小。修改后需重启终端才能生效。',
          fontFamilyLabel: '终端字体',
          fontFamilyDescription:
            '内置终端的 CSS font-family。留空则自动检测或使用默认值。使用 Nerd Font 字体名（如 "MesloLGS Nerd Font"）可正确显示图标字形。'
        },
        external: {
          title: '外部终端',
          description: '选择 “Open in Terminal” 操作默认打开的终端',
          detecting: '正在检测已安装的终端...',
          notFound: '（未找到）',
          customCommand: {
            label: '自定义终端命令',
            description: '调用该命令时会把 worktree 路径作为参数传入。',
            optionLabel: '自定义命令'
          }
        }
      },
      security: {
        title: '安全',
        description: '控制基于审批的 agent 会话中的命令过滤规则',
        enable: {
          label: '启用命令过滤',
          description: '控制需要审批的 agent 在会话中可以使用哪些工具和命令'
        },
        defaultBehavior: {
          label: '未列出命令的默认行为',
          description: '命令不在任一列表中时应如何处理',
          ask: '请求审批',
          allow: '静默允许',
          block: '静默拦截'
        },
        info: {
          title: '支持通配符的模式匹配：',
          single: '* 匹配除 / 之外的任意字符序列',
          double: '** 匹配包含 / 在内的任意字符序列',
          exampleBash: '示例：bash: npm * 可匹配所有 npm 命令',
          exampleRead: '示例：read: src/** 可匹配 src/ 下任意文件'
        },
        priority: {
          title: '优先级：',
          description: 'Blocklist 的优先级高于 allowlist。若一个命令同时匹配两者，会被拦截。'
        },
        tabs: {
          allowlist: '允许列表',
          blocklist: '拦截列表'
        },
        pattern: {
          empty: '模式不能为空',
          duplicate: '该模式已存在于当前列表中',
          added: '已将模式添加到{list}',
          removed: '已从{list}移除模式',
          allowPlaceholder: '例如：bash: git status 或 read: src/**',
          blockPlaceholder: '例如：bash: rm -rf * 或 edit: .env',
          add: '添加',
          searchPlaceholder: '搜索模式...',
          showingCount: '显示 {visible} / {total} 条模式',
          noAllowlist: '允许列表中还没有模式。命令会按默认行为处理。',
          noAllowlistSearch: '没有匹配 “{query}” 的模式',
          noBlocklist: '拦截列表中还没有模式。首次启动时会包含默认危险模式。',
          noBlocklistSearch: '没有匹配 “{query}” 的模式',
          removeTitle: '移除模式'
        }
      },
      privacy: {
        title: '隐私',
        description: '控制玄圃如何收集匿名使用数据',
        analytics: {
          label: '发送匿名使用分析数据',
          description: '通过共享匿名功能使用数据帮助改进玄圃'
        },
        collect: {
          title: '我们会收集：',
          description: '功能使用次数、应用版本、平台信息（macOS/Windows/Linux）。'
        },
        neverCollect: {
          title: '我们绝不会收集：',
          description: '项目名称、文件内容、提示词、AI 回复、git 数据或任何个人信息。'
        }
      },
      shortcuts: {
        title: '键盘快捷键',
        description: '自定义键盘快捷键',
        resetAll: '重置全部',
        resetAllSuccess: '所有快捷键已恢复默认值',
        resetOneSuccess: '快捷键已恢复默认值',
        modifierRequired: '快捷键必须至少包含一个修饰键（Cmd/Ctrl/Alt/Shift）',
        updated: '快捷键已更新为 {binding}',
        conflictTitle: '快捷键冲突',
        conflictDescription: '该按键已被以下操作占用：',
        resetTitle: '恢复默认',
        recording: '请按下按键...',
        categories: {
          recent: '最近',
          navigation: '导航',
          action: '操作',
          git: 'Git',
          settings: '设置',
          file: '文件'
        }
      },
      updates: {
        title: '更新',
        description: '管理玄圃的更新方式',
        currentVersion: '当前版本：',
        channel: {
          label: '更新通道',
          description: '选择接收更新的发布通道',
          stable: '稳定版',
          canary: '金丝雀版',
          stableHint: '你将接收稳定且经过测试的版本。',
          canaryHint: '你将接收包含最新功能的早期构建版本，这些版本可能包含 bug。'
        },
        check: {
          idle: '检查更新',
          busy: '检查中...'
        }
      },
      usage: {
        title: '使用统计',
        description: '查看 Claude 与 Codex 的本地会话成本和 Token 使用情况。',
        actions: {
          refresh: '刷新',
          resync: '重新同步'
        },
        filters: {
          range: '时间范围',
          engine: '引擎'
        },
        ranges: {
          today: '今日',
          '7d': '最近 7 天',
          '30d': '最近 30 天',
          all: '全部'
        },
        engines: {
          all: '全部引擎',
          'claude-code': 'Claude',
          codex: 'OpenAI Codex'
        },
        summary: {
          totalCost: '总成本',
          totalSessions: '会话数',
          totalTokens: '总 Tokens',
          averageCostPerSession: '平均成本 / 会话'
        },
        tokens: {
          input: '输入 Tokens',
          output: '输出 Tokens',
          cacheWrite: 'Cache 写入',
          cacheRead: 'Cache 读取'
        },
        tabs: {
          overview: '概览',
          models: '按模型',
          projects: '按项目',
          sessions: '会话',
          timeline: '时间线'
        },
        overview: {
          topModels: '热门模型',
          topProjects: '热门项目'
        },
        tables: {
          model: '模型',
          project: '项目',
          session: '会话',
          sessions: '会话数',
          tokens: 'Tokens',
          cost: '成本',
          lastUsed: '最近使用'
        },
        partial: {
          partialCount: '有 {count} 个会话的统计数据还不完整。',
          staleCount: '有 {count} 个会话正在后台刷新。'
        },
        empty: '当前筛选范围内还没有可用的使用数据。'
      }
    },
    fileSearch: {
      ariaLabel: '文件搜索',
      commandLabel: '文件搜索',
      placeholder: '按文件名或路径搜索...',
      empty: '没有找到文件。',
      hints: {
        navigate: '导航',
        open: '打开',
        close: '关闭'
      },
      fileCount: '{count} 个文件'
    },
    fileMentionPopover: {
      noFiles: '没有找到文件'
    },
    attachmentButton: {
      label: '附加图片或文件'
    },
    fileTree: {
      ariaLabel: '文件树',
      node: {
        ariaLabel: '{prefix}{kind}：{name}{status}',
        symlinkedPrefix: '符号链接',
        folder: '文件夹',
        file: '文件',
        staged: '已暂存',
        modified: '已修改'
      },
      header: {
        title: '文件',
        collapseAll: '折叠所有文件夹',
        refresh: '刷新文件树',
        closeSidebar: '关闭侧边栏'
      },
      filter: {
        placeholder: '筛选文件...',
        clear: '清空筛选'
      },
      sidebar: {
        changes: '变更',
        files: '文件',
        diffs: '差异',
        comments: '评论',
        closeSidebar: '关闭侧边栏'
      },
      empty: {
        noWorktreeTitle: '选择一个 worktree',
        noWorktreeHint: '以查看它的文件',
        errorTitle: '加载文件失败',
        loading: '正在加载文件...',
        loadingAria: '正在加载文件',
        noFiles: '没有找到文件'
      },
      branchDiff: {
        noWorktree: '未选择 worktree',
        selectBranch: '选择要比较的分支...',
        filterBranches: '筛选分支...',
        local: '本地',
        remote: '远端',
        current: '当前',
        noBranches: '没有找到分支',
        selectBranchToSeeDifferences: '选择一个分支以查看差异',
        loading: '加载中...',
        noDifferences: '没有差异',
        loadError: '加载 diff 文件失败',
        changedCount: '已变更 {count} 个{label}',
        fileSingular: '文件',
        filePlural: '文件',
        noBranchSelected: '未选择分支',
        refresh: '刷新'
      },
      changes: {
        noWorktree: '未选择 worktree',
        refresh: '刷新 Git 状态',
        refreshAll: '全部刷新',
        branchLoading: '加载中...',
        noChanges: '没有变更',
        mergeConflicts: '合并冲突',
        stagedChanges: '已暂存变更',
        changes: '变更',
        untracked: '未跟踪',
        markResolved: '标记为已解决',
        openDiff: '打开 Diff',
        openSourceFile: '打开源文件',
        copyPath: '复制路径',
        pathCopied: '路径已复制到剪贴板',
        unstage: '取消暂存',
        stage: '暂存',
        discardChanges: '丢弃变更',
        delete: '删除',
        addToGitignore: '添加到 .gitignore',
        stageAll: '全部暂存',
        unstageAll: '全部取消暂存',
        discard: '丢弃',
        stageAllTitle: '暂存所有文件',
        unstageAllTitle: '取消暂存所有文件',
        discardAllTitle: '丢弃所有变更',
        clean: '干净',
        connectionNoChanges: '没有变更',
        connectionSummary: '{files} 个{fileLabel}，涉及 {repos} 个{repoLabel}',
        fileSingular: '文件',
        filePlural: '文件',
        repoSingular: '仓库',
        repoPlural: '仓库',
        aheadTooltip: '领先 {count} 个提交',
        behindTooltip: '落后 {count} 个提交',
        toasts: {
          stageAllSuccess: '已暂存所有变更',
          stageAllError: '暂存变更失败',
          unstageAllSuccess: '已取消暂存所有变更',
          unstageAllError: '取消暂存变更失败',
          discardAllSuccess: '已丢弃 {count} 处变更',
          discardPartial: '已丢弃 {success}/{total} 处变更',
          discardAllError: '丢弃变更失败',
          stageFileError: '暂存 {path} 失败',
          unstageFileError: '取消暂存 {path} 失败',
          discardFileSuccess: '已丢弃 {path} 的变更',
          discardFileError: '丢弃 {path} 失败',
          addToGitignoreSuccess: '已将 {path} 添加到 .gitignore',
          addToGitignoreError: '添加到 .gitignore 失败'
        }
      },
      gitStatus: {
        modified: '已修改',
        staged: '已暂存',
        deleted: '已删除',
        untracked: '未跟踪',
        conflicted: '有冲突',
        stagedSuffix: '（已暂存）'
      }
    },
    fileViewer: {
      loading: '正在加载文件...',
      errorTitle: '加载文件失败',
      noContent: '没有内容',
      source: '源码',
      preview: '预览',
      errors: {
        readImage: '读取图片失败',
        readFile: '读取文件失败',
        deletedFromDisk: '文件已从磁盘删除'
      },
      toasts: {
        saved: '文件已保存',
        saveError: '保存失败：{error}'
      },
      externalChanges: {
        message: '此文件在磁盘上已发生更改。',
        keepMine: '保留我的更改',
        reload: '重新加载'
      },
      unsavedChanges: {
        title: '未保存的更改',
        description: '要保存对 {fileName} 的更改吗？',
        dontSave: '不保存',
        cancel: '取消',
        save: '保存'
      }
    },
    quickActions: {
      openInXcode: '在 Xcode 中打开',
      openInAndroidStudio: '在 Android Studio 中打开',
      openInApp: '在 {app} 中打开',
      revealInManager: '在 {manager} 中显示',
      copyPath: '复制路径',
      copyBranchName: '复制分支名',
      copied: '已复制'
    },
    terminalToolbar: {
      status: {
        starting: '启动中...',
        terminal: '终端',
        ghostty: 'Ghostty',
        exited: '已退出（{code}）'
      },
      search: {
        placeholder: '搜索...',
        previous: '上一个匹配（Shift+Enter）',
        next: '下一个匹配（Enter）',
        close: '关闭搜索（Escape）'
      },
      actions: {
        search: '搜索（Cmd+F）',
        clear: '清空终端（Cmd+K）',
        restart: '重启终端'
      }
    },
    runOutputSearch: {
      placeholder: '在输出中查找...',
      count: '{current} / {total}',
      noResults: '没有结果',
      previous: '上一个匹配（Shift+Enter）',
      next: '下一个匹配（Enter）',
      close: '关闭（Escape）'
    },
    setupTab: {
      empty: {
        noWorktree: '选择一个 worktree 以查看 setup 输出',
        noOutput: '当前还没有 setup 输出。点击“重新运行 Setup”开始执行。',
        configure: '配置 setup 脚本'
      },
      status: {
        running: '运行中...',
        complete: 'Setup 已完成',
        failed: 'Setup 失败'
      },
      actions: {
        rerun: '重新运行 Setup'
      }
    },
    copyMessageButton: {
      ariaLabel: '复制消息',
      toasts: {
        copied: '已复制到剪贴板',
        copyError: '复制失败'
      }
    },
    codeBlock: {
      copyButton: '复制代码',
      toasts: {
        copied: '代码已复制到剪贴板',
        copyError: '复制代码失败'
      }
    },
    errorFallback: {
      title: '出了点问题',
      message: '发生了一个未预期的错误',
      retry: '重试'
    },
    updateToast: {
      available: {
        title: '发现 v{version} 更新',
        later: '稍后',
        skip: '跳过此版本',
        download: '下载'
      },
      progress: {
        title: '正在下载 v{version}...'
      }
    },
    ghosttyPromoToast: {
      title: 'Ghostty 原生终端已可用',
      description: '基于 Metal 的原生渲染，并沿用你的 Ghostty 配置',
      dismiss: '不再提示',
      activate: '启用'
    },
    compactionPill: {
      auto: '已自动压缩上下文',
      manual: '已压缩上下文'
    },
    indeterminateProgressBar: {
      asking: '等待回答中',
      working: 'Agent 正在执行'
    },
    gitCommitForm: {
      summaryPlaceholder: '提交摘要',
      descriptionPlaceholder: '补充说明（可选）',
      committing: '提交中...',
      commit: '提交',
      stagedCount: '{count} 个{label}',
      fileSingular: '文件',
      filePlural: '文件',
      conflictWarning: '请先解决合并冲突，再进行提交',
      shortcutHint: '{modifier}+Enter 提交',
      toasts: {
        success: '改动已成功提交',
        commitHash: '提交：{hash}',
        error: '提交失败'
      }
    },
    gitPushPull: {
      actions: {
        push: '推送',
        pull: '拉取',
        merge: '合并',
        archive: '归档',
        delete: '删除'
      },
      merge: {
        label: '合并来源',
        select: '选择分支',
        filterPlaceholder: '筛选分支...',
        loading: '加载中...',
        noMatching: '没有匹配的分支',
        noBranches: '没有找到分支'
      },
      toasts: {
        pushSuccess: '推送成功',
        pushError: '推送失败',
        pullSuccess: '拉取成功',
        pullError: '拉取失败',
        deleteSuccess: '已删除分支 {branch}',
        deleteError: '删除分支失败',
        mergeSuccess: '已成功合并 {branch}',
        mergeError: '合并失败'
      }
    },
    gitStatusPanel: {
      ariaLabel: 'Git 状态',
      loading: '加载中...',
      refresh: '刷新 Git 状态',
      noChanges: '没有变更',
      ahead: '领先 {count} 个提交',
      behind: '落后 {count} 个提交',
      conflictsTitle: '{count} 个文件存在合并冲突，点击可用 AI 修复',
      conflictsButton: '冲突',
      unknownBranch: '未知分支',
      conflictSessionName: '合并冲突：{branch}',
      pendingMessage: '修复合并冲突',
      sections: {
        conflicts: '冲突',
        staged: '已暂存变更',
        changes: '变更',
        untracked: '未跟踪'
      },
      actions: {
        stageAll: '全部暂存',
        stageAllTitle: '暂存所有文件',
        unstageAll: '全部取消暂存',
        unstageAllTitle: '取消暂存所有文件'
      },
      fileItem: {
        stageFile: '暂存 {path}',
        unstageFile: '取消暂存 {path}',
        viewChanges: '查看变更',
        viewChangesTitle: '查看变更：{path}'
      },
      toasts: {
        stageAllSuccess: '已暂存所有变更',
        stageAllError: '暂存变更失败',
        unstageAllSuccess: '已取消暂存所有变更',
        unstageAllError: '取消暂存变更失败',
        stageFileError: '暂存 {path} 失败',
        unstageFileError: '取消暂存 {path} 失败',
        noWorktreeSelected: '未选择 worktree',
        projectNotFound: '找不到该 worktree 对应的项目',
        createSessionError: '创建会话失败',
        conflictResolutionError: '启动冲突修复失败',
        pathCopied: '路径已复制到剪贴板'
      },
      contextMenu: {
        openSourceFile: '打开源文件',
        viewChanges: '查看变更',
        copyPath: '复制路径'
      }
    },
    projectList: {
      error: {
        title: '加载项目失败'
      },
      empty: {
        noProjects: '还没有添加任何项目。',
        addProjectHint: '点击 + 添加一个项目。',
        noProjectsInSpace: '这个空间里还没有项目。',
        assignHint: '右键项目即可将其分配到当前空间。',
        noMatches: '没有匹配的项目'
      }
    },
    terminalManager: {
      empty: {
        selectWorktree: '选择一个 worktree 以打开终端'
      }
    },
    terminalTabBar: {
      rename: '重命名',
      close: '关闭',
      closeOthers: '关闭其他',
      newTerminal: '新建终端'
    },
    appLayout: {
      sidebarError: '侧边栏错误',
      drop: {
        noSession: '请先打开一个会话再附加文件',
        noFolders: '不能附加文件夹。请改为拖入单个文件。',
        maxFiles: '单次最多拖入 {count} 个文件',
        readError: '读取一个或多个拖入文件失败'
      }
    },
    loading: {
      default: '加载中...'
    },
    connectionList: {
      title: '连接'
    },
    addProjectButton: {
      toasts: {
        addError: '添加项目失败',
        initError: '初始化仓库失败',
        initialized: 'Git 仓库已初始化'
      }
    },
    languageIcon: {
      customProjectIcon: '自定义项目图标'
    },
    spaces: {
      allProjects: '全部项目',
      createSpace: '创建空间',
      menu: {
        rename: '重命名',
        changeIcon: '更换图标',
        delete: '删除'
      },
      dialogs: {
        createTitle: '创建空间',
        createDescription: '将你的项目组织到不同空间中。',
        editTitle: '编辑空间',
        editDescription: '更新空间名称或图标。',
        fields: {
          name: '名称',
          icon: '图标'
        },
        namePlaceholder: '例如：工作、Side Projects',
        cancel: '取消',
        create: '创建',
        save: '保存'
      },
      iconPicker: {
        search: '搜索图标...',
        noMatches: '没有匹配的图标'
      }
    },
    mainPane: {
      welcomeTitle: '欢迎使用玄圃',
      welcomeDescription: '选择一个项目或 worktree 以开始使用。',
      loadingSessions: '正在加载会话...',
      noActiveSessionTitle: '当前没有活动会话',
      noActiveSessionDescription: '点击上方的 + 按钮创建一个新会话。'
    },
    agentPicker: {
      title: '选择默认 AI Agent',
      description:
        '检测到已安装多个 AI Agent。请选择新会话默认使用的 Agent。你之后仍可在设置中更改。',
      agents: {
        opencode: {
          title: 'OpenCode',
          description: '开源 AI 编码 Agent'
        },
        claude: {
          title: 'Claude Code',
          description: 'Anthropic 的编码助手'
        },
        codex: {
          title: 'Codex',
          description: 'OpenAI 的编码 Agent'
        }
      }
    },
    onboardingWizard: {
      title: '开发环境就绪引导',
      subtitle: '先检查本机环境，再选择默认 Agent，把第一次启动做得顺滑、清楚、可交付。',
      headerTitle: '首次启动配置',
      headerDescription: '玄圃会检查本地工具链，并帮你选一个合理的默认 Agent。',
      steps: {
        inspect: '1. 检查环境',
        inspectDescription: '确认这台机器已经具备本地 AI 开发的基本条件。',
        choose: '2. 选择默认 Agent',
        chooseDescription: '决定新会话默认使用哪个 Agent。'
      },
      summary: {
        environmentReady: '环境项',
        agentReady: '可直接使用的 Agent',
        detectedAgents: '已安装 CLI',
        selected: '当前选择',
        pending: '还未确定',
        pendingDescription: '先选一个可用 Agent，或者先用终端模式继续。'
      },
      badges: {
        ready: '已就绪',
        warning: '需处理',
        missing: '未安装',
        recommended: '推荐',
        selected: '已选中'
      },
      actions: {
        refresh: '重新检测',
        retry: '重试检测',
        back: '上一步',
        next: '下一步',
        useTerminal: '使用终端模式',
        openDocs: '查看文档',
        runInTerminal: '在终端中打开',
        copyCommand: '复制命令',
        quit: '退出应用',
        start: '使用当前配置开始'
      },
      loading: {
        title: '正在检查本地环境',
        description: '正在验证核心工具、已安装 CLI，以及当前登录状态。'
      },
      error: {
        title: '环境检查未能完成',
        description: '你可以重新检测，或者先用终端模式继续。'
      },
      environment: {
        title: '基础工具',
        description: '这些检查能让你的同事更快进入可工作的初始状态。',
        git: {
          title: 'Git',
          ready: '已检测到 {version}',
          missing: '克隆、分支和 Diff 等能力都依赖 Git。'
        },
        node: {
          title: 'Node.js',
          ready: '已检测到 {version}',
          outdated: '已检测到 {version}，建议升级到 Node 18 及以上。',
          missing: '安装 Claude Code 或 Codex 需要 Node.js。'
        },
        homebrew: {
          title: 'Homebrew',
          ready: '已检测到 {version}',
          missing: '在 macOS 上推荐使用 Homebrew 做一键安装。'
        },
        xcodeCli: {
          title: 'Xcode Command Line Tools',
          ready: '已安装',
          missing: '在 macOS 上推荐安装，便于 Git 和常见本地工具链正常工作。'
        }
      },
      agents: {
        title: '可用 Agent',
        description: '优先选择已就绪的原生 Agent；如果暂时没有，也可以先走终端模式。',
        claudeCode: {
          title: 'Claude Code',
          description: 'Anthropic 的本地编码 Agent，默认规划体验比较成熟。',
          ready: '已安装，并且检测到了登录凭证。',
          loginRequired: '已安装，但还需要先完成 Claude 的登录流程。',
          authUnknown: '已安装，但玄圃暂时无法确认当前登录状态。',
          missing: '当前还没有安装 Claude Code。'
        },
        codex: {
          title: 'Codex',
          description: 'OpenAI 的本地编码 Agent，适合终端优先的开发流程。',
          ready: '已安装，可以直接使用。',
          loginRequired: '已安装，但还需要先完成 Codex 登录。',
          authUnknown: '已安装。玄圃暂时无法确认登录状态，但你现在也可以直接选它。',
          missing: '当前还没有安装 Codex。'
        },
        opencode: {
          title: 'OpenCode',
          description: '开源编码 Agent，Provider 路由更灵活。',
          ready: '已安装。模型接入会在首次会话里完成。',
          loginRequired: '已安装，但 Provider 配置还需要处理。',
          authUnknown: '已安装。Provider 可用性会在首次会话里确认。',
          missing: '当前还没有安装 OpenCode。'
        },
        terminal: {
          title: '终端模式',
          description: '先把玄圃当作项目工作台使用，之后再接入 Agent。',
          detail:
            '终端模式会先跳过原生 Agent 配置，但你仍然可以使用项目、worktree 和集成终端这些核心能力。'
        }
      },
      helper: {
        selectedReady: '继续后，新会话会默认使用 {agent}。',
        fallbackTitle: '兜底路径',
        installTitle: '安装指引',
        loginTitle: '登录指引',
        selectedTitle: '当前选择',
        whyTitle: '说明',
        recommendedDescription: '玄圃推荐 {agent}，因为它是当前这台机器上最适合直接开箱即用的方案。',
        terminalDescription:
          '终端模式是一个安全兜底。之后你仍然可以在设置里切换到 Claude Code、Codex 或 OpenCode。',
        commandLabel: '建议命令',
        installDescription: '先安装 {agent}，然后再重新跑一次检测。',
        loginDescription: '先完成 {agent} 的登录流程，然后再重新跑一次检测。',
        environmentReady: '基础环境已经就绪，可以继续选择默认 Agent。',
        environmentNeedsAttention: '还有 {count} 项环境检查需要处理，但你仍然可以继续。',
        agentReadyDescription: '{agent} 已经可用，现在就可以把它设为默认 Agent。',
        agentNotReady: '它暂时还不能直接选中。先按下方指引完成安装或登录。',
        authUnknownDescription:
          '玄圃暂时无法确认 {agent} 的登录状态，但如果你愿意，也可以现在就把它设成默认。',
        loginHintClaude: '先启动 Claude Code，然后按交互提示完成登录。',
        loginHintCodex: '执行登录命令，并完成 ChatGPT 或 API Key 认证流程。',
        loginHintOpencode: '先启动 OpenCode，然后在交互界面里完成 Provider 配置。'
      },
      toasts: {
        commandCopied: '命令已复制到剪贴板',
        docsOpened: '已打开官方文档',
        terminalOpened: '已在系统终端中打开命令',
        actionFailed: '操作失败',
        selectedAgentRequired: '先选择一个可用 Agent，或者改用终端模式继续。'
      }
    },
    sessionView: {
      compacting: '正在压缩上下文窗口...',
      loading: {
        title: '正在连接会话...',
        subtitle: '这可能需要一点时间'
      },
      error: {
        title: '连接错误',
        retry: '重新连接',
        fallback: '连接会话失败',
        connectOpencode: '连接 OpenCode 失败',
        connectSession: '连接会话失败',
        connectGeneric: '连接失败',
        sessionNotFound: '找不到会话'
      },
      empty: {
        title: '开始一段对话',
        subtitle: '在下方输入消息以开始',
        connectingOpencode: '正在连接到 OpenCode...',
        noWorktree: '未选择 worktree'
      },
      revert: {
        summarySingular: '已回退 1 条消息',
        summaryPlural: '已回退 {count} 条消息',
        restore: '使用 /redo 恢复'
      },
      sessionError: {
        title: '会话错误'
      },
      retry: {
        withCountdown: '{seconds} 秒后重试（第 {attempt} 次）',
        withoutCountdown: '正在重试（第 {attempt} 次）'
      },
      composer: {
        waitingPermissionResponse: '正在等待授权回复...',
        waitingQuestionResponse: '正在等待你的回答...',
        waitingCommandApprovalResponse: '正在等待命令审批回复...',
        planFeedbackPlaceholder: '输入反馈以修改计划...',
        messagePlaceholder: '输入你的消息...',
        blockedByQuestionTitle: '先回答当前问题，再继续对话',
        blockedByPermissionTitle: '先处理当前授权请求',
        blockedByCommandApprovalTitle: '先处理当前命令审批请求',
        blockedHint: '完成上方交互后，聊天输入区会自动恢复。',
        inputAriaLabel: '消息输入框',
        planFeedbackHint: '按 Enter 发送反馈以修改计划',
        planModeLabel: 'Plan模式',
        activatePlanMode: '进入 Plan',
        returnToBuildMode: '返回 Build',
        changeVariantHint: '按 {shortcut} 切换变体，Shift+Enter 换行',
        stopStreaming: '停止输出',
        sendFeedback: '发送反馈',
        sendFeedbackTitle: '发送反馈以修改计划',
        queueMessage: '加入队列',
        sendMessage: '发送消息'
      },
      costPill: {
        title: '会话计费',
        totalCost: '总成本',
        totalTokens: '总 Tokens',
        input: '输入',
        output: '输出',
        cacheWrite: 'Cache 写入',
        cacheRead: 'Cache 读取',
        model: '模型',
        duration: '时长',
        partialData: '部分历史数据尚未完成同步。'
      },
      connection: {
        disconnectedPlaceholder: 'OpenCode 未连接。请确认已选中 worktree，并且连接已成功建立。'
      },
      completion: {
        alt: '小蜜蜂',
        defaultWord: '已完成',
        forDuration: '{word}，耗时 {duration}'
      },
      toasts: {
        maxAttachmentsReached: '最多只能附加 {count} 个附件',
        partialAttachments: '仅附加了 {attached}/{total} 个文件（上限 {count} 个）',
        refreshResponseError: '刷新回复失败',
        followUpPromptError: '发送后续提示失败',
        reviewPromptError: '发送审查提示失败',
        answerError: '发送答案失败',
        dismissQuestionError: '忽略问题失败',
        permissionReplyError: '发送授权回复失败',
        commandApprovalReplyError: '发送命令审批回复失败',
        notConnected: 'OpenCode 未连接',
        nothingToUndo: '没有可撤销的内容',
        redoUnsupported: '当前会话类型不支持重做',
        nothingToRedo: '没有可重做的内容',
        undoRedoRefreshFailed: '撤销/重做已完成，但刷新失败',
        undoFailed: '撤销失败',
        redoFailed: '重做失败',
        askMissingQuestion: '请在 /ask 后输入问题',
        questionError: '发送问题失败',
        commandError: '发送命令失败',
        messageToAiError: '向 AI 发送消息失败',
        messageError: '发送消息失败',
        forkNotReady: '当前会话还不能分叉',
        forkNoWorktree: '当前会话没有可分叉到的 worktree',
        forkMessageNotFound: '找不到所选消息',
        forkFailed: '分叉会话失败',
        noPendingPlanApproval: '没有待处理的计划批准',
        planApproveFailed: '批准计划失败：{error}',
        planApproveError: '批准计划时出错：{error}',
        planRejectFailed: '拒绝计划失败：{error}',
        planRejectError: '拒绝计划时出错：{error}',
        noAssistantPlanToHandoff: '没有可移交的助手计划消息',
        startHandoffSessionError: '无法启动移交会话',
        createHandoffSessionError: '创建移交会话失败',
        noPlanContentToSupercharge: '没有可用于 supercharge 的计划内容',
        currentWorktreeNotFound: '找不到当前 worktree',
        projectForWorktreeNotFound: '找不到该 worktree 对应的项目',
        duplicateWorktreeError: '复制 worktree 失败',
        createSuperchargeSessionError: '创建 supercharge 会话失败',
        startLocalSuperchargeSessionError: '无法启动本地 supercharge 会话',
        createLocalSuperchargeSessionError: '创建本地 supercharge 会话失败'
      }
    },
    sessionTerminalView: {
      loading: '正在加载终端...'
    },
    sessionHistory: {
      title: '会话历史',
      common: {
        untitled: '未命名会话',
        untitledShort: '未命名',
        archived: '已归档'
      },
      date: {
        todayAt: '今天 {time}',
        yesterdayAt: '昨天 {time}'
      },
      actions: {
        loadSession: '加载会话'
      },
      search: {
        placeholder: '搜索标题、项目或 worktree...',
        hint: '关键词搜索仅匹配会话元数据（标题、项目和 worktree）。'
      },
      filters: {
        project: '项目',
        worktree: 'Worktree',
        allProjects: '全部项目',
        allWorktrees: '全部 Worktree',
        dateRange: '日期范围',
        anyTime: '任意时间',
        from: '从',
        to: '到',
        more: '更多',
        includeArchived: '包含已归档的 worktree',
        clear: '清空筛选'
      },
      empty: {
        title: '没有找到会话',
        filtered: '试试调整搜索筛选条件以找到更多会话。',
        default: '开始在某个 worktree 中工作，即可创建第一个会话。'
      },
      preview: {
        archivedWorktree: '该会话所属的 worktree 已归档',
        created: '创建于 {date}',
        updated: '更新于 {date}',
        messagesTitle: '消息预览',
        noMessages: '该会话中没有消息',
        moreMessages: '……还有更多消息'
      },
      results: {
        count: '找到 {count} 个{label}',
        sessionSingular: '会话',
        sessionPlural: '会话'
      },
      toasts: {
        loaded: '已加载会话“{name}”',
        loadError: '加载会话失败',
        readOnlyArchived: '该会话来自已归档的 worktree。将以只读模式打开。'
      }
    },
    sessionTabs: {
      common: {
        untitled: '未命名',
        staged: '已暂存',
        unstaged: '未暂存'
      },
      menu: {
        close: '关闭',
        closeOthers: '关闭其他标签',
        closeToRight: '关闭右侧其他标签',
        copyRelativePath: '复制相对路径',
        copyAbsolutePath: '复制绝对路径'
      },
      actions: {
        createSession: '创建新会话（右键查看更多选项）',
        newOpenCode: '新建 OpenCode 会话',
        newClaudeCode: '新建 Claude Code 会话',
        newCodex: '新建 Codex 会话',
        newTerminal: '新建终端'
      },
      empty: {
        noSessions: '还没有会话。点击 + 创建一个。'
      },
      context: {
        title: 'Worktree 上下文',
        label: '上下文'
      },
      toasts: {
        copied: '已复制到剪贴板'
      },
      errors: {
        createSession: '创建会话失败',
        closeSession: '关闭会话失败',
        renameSession: '重命名会话失败'
      }
    },
    slashCommandPopover: {
      loading: '正在加载命令...',
      noMatches: '没有匹配的命令',
      badges: {
        plan: '计划',
        build: '执行',
        builtIn: '内置'
      },
      descriptions: {
        undo: '撤销上一条消息和文件改动',
        redo: '重做上一次被撤销的消息和文件改动',
        clear: '关闭当前标签页并打开一个新标签页',
        ask: '提问，但不进行代码修改'
      }
    },
    planReadyFab: {
      labels: {
        handoff: '移交',
        superchargeLocal: '本地增强',
        supercharge: '增强执行',
        implement: '开始实现'
      },
      aria: {
        handoff: '移交计划',
        superchargeLocal: '在本地增强执行计划',
        supercharge: '增强执行计划',
        implement: '实现计划'
      }
    },
    scrollToBottomFab: {
      ariaLabel: '滚动到底部'
    },
    forkMessageButton: {
      ariaLabel: '分叉消息'
    },
    leftSidebar: {
      ariaLabel: '项目和 worktree'
    },
    rightSidebar: {
      ariaLabel: '文件侧边栏',
      fileSidebarError: '文件侧边栏出错'
    },
    reasoningBlock: {
      thinking: '思考中...'
    },
    queuedIndicator: {
      label: '{count} 条消息排队中'
    },
    queuedMessageBubble: {
      badge: '排队中'
    },
    toolCallContextMenu: {
      actions: {
        copyDetails: '复制详情',
        inspect: '查看工具调用'
      },
      toasts: {
        nothingToCopy: '没有可复制的内容',
        copied: '已复制到剪贴板',
        copyError: '复制失败'
      }
    },
    toolCallDebugModal: {
      title: '工具调用查看器',
      tabs: {
        input: '输入',
        output: '输出'
      },
      actions: {
        copied: '已复制',
        copy: '复制{label}'
      },
      toasts: {
        copied: '{label}已复制到剪贴板',
        copyError: '复制失败'
      },
      status: {
        pending: '等待中',
        running: '运行中',
        success: '成功',
        error: '失败'
      }
    },
    runTab: {
      empty: {
        noWorktree: '选择一个 worktree 以运行脚本',
        noOutput: '当前还没有运行输出。按 ⌘R 或点击运行开始执行。',
        setupScript: '配置运行脚本'
      },
      status: {
        running: '运行中',
        stopped: '已停止'
      },
      actions: {
        clear: '清空',
        stop: '停止',
        restart: '重启',
        run: '运行'
      }
    },
    errorBoundary: {
      title: '出了点问题',
      componentPrefix: '错误位置：',
      unexpected: '发生了一个未预期的错误',
      tryAgain: '重试',
      reloadApp: '重新加载应用',
      copied: '已复制',
      copyError: '复制错误信息',
      developerDetails: '开发者详情'
    },
    worktreeContext: {
      title: 'Worktree 上下文',
      unsaved: '存在未保存更改',
      preview: '预览',
      edit: '编辑',
      close: '关闭',
      save: '保存上下文',
      empty:
        '当前还没有设置 worktree 上下文。点击“编辑”即可添加，这些内容会注入到 AI 会话的首条提示中。',
      confirmDiscard: '你有未保存的更改。要丢弃吗？',
      placeholder:
        '在这里输入 worktree 上下文。每个新 AI 会话的第一条提示中都会注入这段 markdown。\n\n示例：\n## 功能：用户认证\n- 正在开发登录/注册流程\n- 后端 API 位于 /api/auth\n- 使用 JWT token',
      toasts: {
        loadError: '加载 worktree 上下文失败',
        saved: '上下文已保存',
        saveError: '保存上下文失败'
      }
    },
    codexFastToggle: {
      label: '快速',
      title: '快速模式',
      description: '快速模式会消耗你套餐中 2 倍的用量。',
      cancel: '取消',
      accept: '接受',
      enabled: '已启用',
      disabled: '已禁用',
      ariaLabel: '快速模式{state}'
    },
    sessionTaskTracker: {
      title: '共 {total} 个任务，已完成 {completed} 个',
      pending: '剩余 {count} 项待处理',
      cancelled: '已取消 {count} 项',
      allDone: '全部任务已完成',
      more: '还有 {count} 项',
      expand: '展开任务',
      collapse: '收起任务'
    },
    toolCard: {
      labels: {
        bash: 'Bash',
        tasks: '任务',
        read: '读取',
        write: '写入',
        edit: '编辑',
        search: '搜索',
        findFiles: '查找文件',
        skill: '技能',
        question: '问题',
        agent: 'Agent',
        plan: '计划',
        fetch: '抓取',
        lsp: 'LSP',
        figma: 'Figma'
      },
      actions: {
        view: '查看',
        hide: '收起'
      },
      fallback: {
        unknown: '未知'
      },
      summary: {
        completed: '已完成 {completed}/{total}',
        active: '{count} 个进行中',
        lines: '{count} 行',
        more: '+{count} 个更多',
        inPath: '位于 {path}',
        questions: '{count} 个问题',
        accepted: '已接受',
        rejected: '已拒绝',
        review: '待审阅',
        implementPlan: '开始实现该计划'
      }
    },
    questionPrompt: {
      custom: {
        typeOwn: '输入你自己的答案',
        placeholder: '输入你的答案...'
      },
      actions: {
        submit: '提交',
        submitAll: '全部提交',
        cancel: '取消',
        back: '上一步',
        next: '下一步',
        dismiss: '忽略',
        sending: '发送中...'
      }
    },
    bottomPanel: {
      tabs: {
        setup: '初始化',
        run: '运行',
        terminal: '终端'
      },
      chrome: {
        openTitle: '在浏览器中打开 {url}（右键可配置）',
        customCommand: '自定义 Chrome 命令',
        placeholderHelp: '使用 {url} 作为占位符。留空则使用默认浏览器。',
        cancel: '取消',
        save: '保存',
        saved: 'Chrome 命令已保存'
      }
    },
    fileContextMenu: {
      viewChanges: '查看变更',
      stageFile: '暂存文件',
      unstageFile: '取消暂存文件',
      discardChanges: '丢弃变更',
      confirmDiscard: '再次点击以确认',
      addToGitignore: '添加到 .gitignore',
      openInEditor: '在编辑器中打开',
      openInFileManager: '在 {manager} 中打开',
      revealInFinder: '在 Finder 中显示',
      revealInExplorer: '在资源管理器中显示',
      copyPath: '复制路径',
      copyRelativePath: '复制相对路径'
    },
    diffUi: {
      status: {
        compareBranch: '对比 {branch}',
        newFile: '新文件',
        staged: '已暂存',
        unstaged: '未暂存',
        stagedChanges: '已暂存变更',
        unstagedChanges: '未暂存变更'
      },
      actions: {
        split: '分栏',
        unified: '统一',
        copy: '复制',
        moreContext: '更多上下文',
        previousHunk: '上一个变更块（Alt+Up）',
        nextHunk: '下一个变更块（Alt+Down）',
        previousChange: '上一个变更（Alt+Up）',
        nextChange: '下一个变更（Alt+Down）',
        showMoreContext: '显示更多上下文',
        switchToSplitView: '切换到分栏视图',
        switchToUnifiedView: '切换到统一视图',
        switchToInlineView: '切换到内联视图',
        switchToSideBySideView: '切换到并排视图',
        copyToClipboard: '复制到剪贴板',
        closeWithEsc: '关闭（Esc）',
        stageChange: '暂存这处变更',
        unstageChange: '取消暂存这处变更',
        revertChange: '还原这处变更'
      },
      viewer: {
        noChanges: '没有变更',
        parseError: '解析 diff 失败',
        ariaLabel: '文件 diff 查看器'
      },
      toasts: {
        diffCopied: 'Diff 已复制到剪贴板',
        fileContentCopied: '文件内容已复制到剪贴板',
        hunkStaged: '变更块已暂存',
        hunkUnstaged: '变更块已取消暂存',
        hunkReverted: '变更块已还原'
      },
      errors: {
        loadDiff: '加载 diff 失败',
        loadFileContent: '加载文件内容失败',
        loadImageDiff: '加载图片 diff 失败',
        loadHeadVersion: '加载 HEAD 版本失败',
        loadStagedVersion: '加载已暂存版本失败',
        loadOriginalVersion: '加载原始版本失败',
        loadDiffContent: '加载 diff 内容失败',
        stageHunk: '暂存变更块失败',
        unstageHunk: '取消暂存变更块失败',
        revertHunk: '还原变更块失败'
      },
      image: {
        before: '变更前',
        after: '变更后'
      }
    },
    dialog: {
      close: '关闭'
    },
    permissionPrompt: {
      header: {
        required: '需要授权',
        alwaysAllowFallback: '始终允许这类操作'
      },
      types: {
        bash: '运行命令',
        edit: '编辑文件',
        read: '读取文件',
        search: '搜索文件',
        webAccess: '访问网络',
        externalDirectory: '外部目录',
        task: '运行子任务'
      },
      actions: {
        sending: '发送中...',
        allowOnce: '允许一次',
        allowAlways: '始终允许',
        deny: '拒绝'
      }
    },
    commandApprovalPrompt: {
      header: {
        required: '需要命令审批',
        tool: '工具：{name}'
      },
      types: {
        bash: '执行命令',
        edit: '编辑文件',
        write: '写入文件',
        read: '读取文件',
        search: '搜索文件',
        web: '访问网络',
        task: '运行子任务',
        skill: '执行技能',
        notebookEdit: '编辑 Notebook'
      },
      subCommands: {
        alreadyAllowed: '已允许'
      },
      patternPicker: {
        allowPerCommand: '选择要始终允许的模式（每条命令各一个）：',
        allowOne: '选择要始终允许的模式：',
        blockOne: '选择要始终阻止的模式：',
        saving: '保存中...',
        cancel: '取消'
      },
      actions: {
        sending: '发送中...',
        allowOnce: '允许一次',
        allowAlways: '始终允许',
        allowAlwaysTitle: '始终允许此命令模式',
        blockAlways: '始终阻止',
        blockAlwaysTitle: '始终阻止此命令模式',
        deny: '拒绝'
      }
    },
    prReview: {
      viewer: {
        loading: '正在加载审查评论...',
        retry: '重试',
        empty: '这个 PR 还没有审查评论',
        refresh: '刷新评论',
        allHidden: '所有评论都已被筛选器隐藏',
        selectedCount: '已选择 {count} 条',
        selectAll: '全选',
        deselect: '取消选择',
        addToChat: '添加到聊天',
        reviewer: {
          show: '显示 {login} 的评论',
          hide: '隐藏 {login} 的评论'
        }
      },
      store: {
        fetchError: '获取评论失败',
        unknownReviewer: '未知评论者',
        unknownPath: '未知文件'
      },
      commentCard: {
        copied: '已复制原始评论 HTML',
        outdated: '旧',
        copyRawHtml: '复制原始 HTML'
      }
    },
    toolViews: {
      common: {
        showLess: '收起',
        showAllLines: '显示全部 {count} 行'
      },
      grep: {
        in: '在',
        matchCount: '{count} 个{label}',
        matchSingular: '匹配',
        matchPlural: '匹配',
        noMatches: '未找到匹配结果',
        showAllResults: '显示全部 {count} 条结果'
      },
      read: {
        linesRange: '第 {start}-{end} 行',
        fromLine: '从第 {start} 行开始',
        firstLines: '前 {count} 行'
      },
      fileChange: {
        add: '新增',
        delete: '删除',
        update: '更新',
        moreLines: '... 还有 {count} 行',
        noDiffContent: '没有 diff 内容',
        noChanges: '没有文件变更'
      },
      edit: {
        lineCount: '{count} {label}',
        lineSingular: '行',
        linePlural: '行',
        moreRemoved: '... 还有 {count} 行被移除',
        moreAdded: '... 还有 {count} 行被新增',
        noChanges: '没有变更'
      },
      fallback: {
        todo: '待完善',
        error: '错误',
        input: '输入',
        output: '输出',
        note: '暂无自定义渲染器，当前显示原始数据'
      },
      skill: {
        loading: '正在加载技能内容...'
      },
      exitPlan: {
        empty: '没有可用的计划内容。'
      },
      todo: {
        empty: '没有任务'
      },
      webFetch: {
        bytesSingular: '{count} 字节',
        bytesPlural: '{count} 字节',
        kb: '{value} KB',
        mb: '{value} MB'
      },
      lsp: {
        noHover: '没有悬停信息',
        noResults: '没有结果',
        noDiagnostics: '没有诊断信息',
        unknown: '未知',
        showAll: '显示全部 {count} 条{label}',
        labels: {
          locations: '位置',
          calls: '调用',
          symbols: '符号',
          diagnostics: '诊断'
        },
        operations: {
          definition: '定义',
          hover: '悬停',
          references: '引用',
          symbols: '符号',
          workspaceSymbols: '工作区符号',
          implementation: '实现',
          callers: '调用方',
          callees: '被调用方',
          diagnostics: '诊断'
        },
        symbolKinds: {
          file: '文件',
          module: '模块',
          namespace: '命名空间',
          package: '包',
          class: '类',
          method: '方法',
          property: '属性',
          field: '字段',
          constructor: '构造函数',
          enum: '枚举',
          interface: '接口',
          function: '函数',
          variable: '变量',
          constant: '常量',
          string: '字符串',
          number: '数字',
          boolean: '布尔值',
          array: '数组',
          object: '对象',
          key: '键',
          null: '空值',
          enumMember: '枚举成员',
          struct: '结构体',
          event: '事件',
          operator: '运算符',
          typeParam: '类型参数'
        }
      },
      task: {
        defaultTitle: '子代理',
        prompt: '提示词'
      }
    },
    contextIndicator: {
      title: '上下文窗口',
      summary: {
        withLimit: '{used} / {limit} tokens ({percent}%)',
        noLimit: '{used} tokens（无法获取上限）'
      },
      labels: {
        input: '输入',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入'
      },
      generated: {
        title: '生成内容（不计入上下文）',
        output: '输出',
        reasoning: '推理'
      },
      cost: {
        session: '会话成本：{cost}'
      }
    },
    helpOverlay: {
      title: '键盘快捷键',
      mode: {
        normal: '普通',
        insert: '插入'
      },
      sections: {
        vimNavigation: 'Vim 导航',
        panelShortcuts: '面板快捷键',
        actionShortcuts: '操作快捷键',
        sidebarHints: '侧边栏提示',
        sessionHints: '会话提示',
        systemShortcuts: '系统快捷键'
      },
      rows: {
        navigateWorktrees: '在 worktree 之间导航',
        navigateSessionTabs: '在会话标签之间导航',
        filterProjectsInsert: '筛选项目（进入插入模式）',
        returnToNormalMode: '返回普通模式',
        toggleHelp: '切换此帮助面板',
        prevNextFileTab: '上一个 / 下一个文件标签'
      },
      panels: {
        changes: '变更',
        files: '文件',
        diffs: '差异',
        setup: '启动脚本',
        run: '运行',
        terminal: '终端'
      },
      actions: {
        review: '审查',
        pr: 'PR',
        mergePr: '合并 PR',
        archive: '归档'
      },
      dynamic: {
        pinnedPrefix: '[固定] {name}',
        connectionFallback: '连接'
      }
    },
    keyboardShortcuts: {
      items: {
        sessionNew: '新建会话',
        sessionClose: '关闭会话',
        sessionModeToggle: '切换 Build / Plan 模式',
        projectRun: '运行项目',
        modelCycleVariant: '切换模型变体',
        navFileSearch: '搜索文件',
        navCommandPalette: '打开命令面板',
        navSessionHistory: '打开会话历史',
        navNewWorktree: '新建 worktree',
        gitCommit: '聚焦提交表单',
        gitPush: '推送到远端',
        gitPull: '从远端拉取',
        navFilterProjects: '筛选项目',
        sidebarToggleLeft: '切换左侧边栏',
        sidebarToggleRight: '切换右侧边栏',
        focusLeftSidebar: '聚焦左侧边栏',
        focusMainPane: '聚焦主面板',
        settingsOpen: '打开设置'
      }
    },
    connectionStore: {
      toasts: {
        unknownError: '未知错误',
        createError: '创建连接失败：{error}',
        createSuccess: '连接“{name}”已创建',
        deleteError: '删除连接失败',
        deleteErrorWithReason: '删除连接失败：{error}',
        deleteSuccess: '连接已删除',
        addMemberError: '添加成员失败：{error}',
        removeMemberError: '移除成员失败：{error}',
        notFound: '未找到连接',
        updateSuccess: '连接已更新',
        updateError: '更新连接失败：{error}',
        renameError: '重命名连接失败',
        renameErrorWithReason: '重命名连接失败：{error}'
      }
    },
    pinnedStore: {
      toasts: {
        pinConnectionError: '固定连接失败',
        unpinConnectionError: '取消固定连接失败'
      }
    },
    sessionStore: {
      errors: {
        createConnectionSession: '创建连接会话失败'
      }
    },
    commandPalette: {
      ariaLabel: '命令面板',
      commandLabel: '命令面板',
      backAriaLabel: '返回上一级',
      placeholderRoot: '输入命令或开始搜索...',
      placeholderIn: '在 {label} 中搜索...',
      empty: '没有找到命令。',
      results: '结果',
      hints: {
        navigate: '导航',
        select: '选择',
        close: '关闭',
        goBack: '返回',
        or: '或'
      },
      categories: {
        recent: '最近',
        navigation: '导航',
        action: '操作',
        git: 'Git',
        settings: '设置',
        file: '文件'
      }
    },
    sidebar: {
      projects: '项目',
      filterProjects: '筛选项目...',
      filterPopover: {
        noMatchingCommands: '没有匹配的命令',
        noMatchingLanguages: '没有匹配的语言'
      },
      recentToggleTitle: '切换最近活动视图',
      sortProjectsTitle: '按最近消息排序',
      addProjectTitle: '添加项目',
      connectionMode: {
        selectWorktrees: '选择 worktree',
        cancel: '取消',
        connect: '连接',
        connecting: '连接中...'
      }
    },
    recent: {
      title: '最近',
      connectionFallback: '连接',
      status: {
        answering: '等待回答',
        commandApproval: '审批命令',
        permission: '等待授权',
        planning: '规划中',
        working: '执行中',
        planReady: '计划已就绪',
        ready: '就绪'
      }
    },
    dialogs: {
      archiveConfirm: {
        title: '存在未提交变更',
        description: '{worktreeName} 中有未提交的变更，继续后这些变更将被永久丢失。',
        binary: '二进制',
        noChanges: '无变更',
        moreFiles: '另有 {count} 个{label}',
        fileSingular: '文件',
        filePlural: '文件',
        cancel: '取消',
        confirm: '仍然归档'
      },
      gitInit: {
        title: '不是 Git 仓库',
        selectedFolder: '所选文件夹不是 Git 仓库：',
        question: '要为它初始化一个新的 Git 仓库吗？',
        cancel: '取消',
        confirm: '初始化仓库'
      },
      connect: {
        title: '连接 Worktree',
        description: '选择其他项目中的 worktree，将它们连接到同一个共享工作区。',
        existingConnections: '已有连接',
        addToExisting: '加入已有连接',
        filterPlaceholder: '筛选 worktree...',
        noWorktrees: '当前没有来自其他项目的 worktree 可供连接。',
        noWorktreesHint: '请先向玄圃添加另一个项目。',
        noMatches: '没有匹配筛选条件的 worktree',
        selectedCount: '已选择 {count} 个{label}',
        selectedNone: '请选择要连接的 worktree',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktree',
        connect: '连接',
        connecting: '连接中...'
      },
      manageConnectionWorktrees: {
        title: '连接中的 Worktree',
        description: '管理这个连接中包含哪些 worktree。',
        filterPlaceholder: '筛选 worktree...',
        noWorktrees: '没有找到活跃的 worktree。',
        noMatches: '没有匹配筛选条件的 worktree',
        selectedNone: '至少选择 1 个 worktree',
        selectedCount: '已选择 {count} 个{label}',
        worktreeSingular: 'worktree',
        worktreePlural: 'worktree',
        save: '保存',
        saving: '保存中...'
      },
      addAttachment: {
        title: '添加附件',
        placeholder: '粘贴 Jira 或 Figma 链接',
        detected: {
          jira: 'Jira 工单',
          figma: 'Figma 文件'
        },
        unsupportedUrl: '不支持的链接',
        confirm: '添加',
        toasts: {
          added: '已附加{type}：{label}',
          addError: '添加附件失败'
        }
      },
      projectSettings: {
        title: '项目设置',
        icon: {
          label: '项目图标',
          description: '显示在侧边栏中的自定义图标，支持 SVG、PNG、JPG 和 WebP。',
          change: '更换',
          changing: '选择中...',
          clear: '清除',
          pickError: '选择图标失败',
          removeError: '移除图标失败'
        },
        autoAssignPort: {
          label: '自动分配端口',
          description:
            '为每个 worktree 分配唯一端口，并将 PORT 注入 run/setup 脚本。端口从 3011 开始。'
        },
        setupScript: {
          label: 'Setup 脚本',
          description: '初始化新 worktree 时运行的命令。每一行都会作为独立命令执行。',
          placeholder: 'pnpm install\npnpm run build'
        },
        runScript: {
          label: 'Run 脚本',
          description: '按下 ⌘R 时触发的命令。运行中再次按 ⌘R 会停止。',
          placeholder: 'pnpm run dev'
        },
        archiveScript: {
          label: 'Archive 脚本',
          description: '归档 worktree 前运行的命令。即使失败也不会阻止归档。',
          placeholder: 'pnpm run clean'
        },
        cancel: '取消',
        save: '保存',
        saving: '保存中...',
        saveSuccess: '项目设置已保存',
        saveError: '保存项目设置失败',
        modelProfile: '模型配置',
        modelProfileDescription: '为此项目选择模型配置'
      },
      worktreeSettings: {
        title: '工作区设置',
        modelProfile: '模型配置',
        modelProfileDescription: '为此工作区覆盖模型配置。未设置时回退到项目配置或全局默认配置。',
        save: '保存',
        saving: '保存中...',
        cancel: '取消',
        saveSuccess: '工作区设置已保存',
        saveError: '保存工作区设置失败',
        profileSynced: '模型配置已更新 — 下一条消息将使用新设置'
      },
      branchPicker: {
        title: '新建工作区',
        description: '选择一个分支或 PR，以此创建新的工作区。',
        tabs: {
          branches: '分支',
          prs: 'PR'
        },
        filterBranches: '筛选分支...',
        filterPRs: '筛选 PR...',
        loadingBranches: '正在加载分支...',
        noBranchesMatch: '没有匹配筛选条件的分支',
        noBranches: '没有找到分支',
        remote: '远端',
        active: '已激活',
        loadingPRs: '正在加载 PR...',
        noPRsMatch: '没有匹配筛选条件的 PR',
        noPRs: '没有打开的 PR',
        branchCount: '{count} 个{label}{match}',
        prCount: '{count} 个{label}{match}',
        branchSingular: '分支',
        branchPlural: '分支',
        prSingular: 'PR',
        prPlural: 'PR',
        matching: '，匹配 “{query}”'
      }
    },
    header: {
      controls: {
        fixConflicts: '修复冲突',
        fixingConflicts: '正在修复冲突...',
        archiveWorktreeTitle: '归档 worktree',
        archive: '归档',
        archiving: '归档中...',
        mergePRTitle: '合并 Pull Request',
        mergePR: '合并 PR',
        merging: '合并中...',
        reviewTitle: '用 AI 审查分支改动',
        review: '审查',
        noRemoteBranches: '没有远端分支',
        attached: '已关联',
        loadingPRs: '正在加载 PR...',
        noOpenPRs: '没有打开的 PR',
        detachPR: '解除 PR 关联',
        createPRTitle: '创建 Pull Request（右键可关联已有 PR）',
        attachExistingPR: '关联已有 PR',
        sessionHistoryTitle: '会话历史（⌘K）',
        settingsTitle: '设置（⌘,）',
        showSidebar: '显示侧边栏',
        hideSidebar: '隐藏侧边栏',
        merged: '已合并',
        closed: '已关闭'
      },
      toasts: {
        loadPRsError: '加载 PR 失败',
        noWorktreeSelected: '未选择 worktree',
        projectNotFound: '找不到该 worktree 对应的项目',
        createPRSessionError: '创建 PR 会话失败',
        createReviewSessionError: '创建审查会话失败',
        prMergedSuccess: 'PR 已成功合并',
        mergePRError: '合并 PR 失败',
        mergePRErrorWithReason: '合并失败：{error}'
      },
      sessionNames: {
        pr: 'PR -> {branch}',
        review: '代码审查 - {branch} 对比 {target}',
        conflicts: '合并冲突 - {branch}'
      }
    },
    modelSelector: {
      title: '选择模型',
      ariaLabel: '当前模型：{model}。点击以切换模型',
      loading: '加载中...',
      filterPlaceholder: '筛选模型...',
      favorites: '收藏',
      empty: {
        filtered: '没有匹配的模型',
        default: '没有可用模型'
      },
      toasts: {
        variant: '变体：{variant}'
      }
    },
    pinned: {
      title: '已固定',
      connectionFallback: '连接',
      connectionNamePlaceholder: '连接名称',
      menu: {
        open: '打开',
        detach: '解除关联',
        addAttachment: '添加附件',
        editContext: '编辑上下文',
        worktreeSettings: '工作区设置',
        openInTerminal: '在终端中打开',
        openInEditor: '在编辑器中打开',
        openInFileManager: '在 {manager} 中打开',
        copyPath: '复制路径',
        pin: '固定',
        unpin: '取消固定',
        connectTo: '连接到...',
        renameBranch: '重命名分支',
        duplicate: '复制',
        unbranch: '移除 worktree',
        keepBranch: '保留分支',
        archive: '归档',
        deleteBranch: '删除分支',
        removeWorktree: '移除 worktree',
        detachedHead: 'Detached HEAD',
        connectionWorktrees: '连接中的 Worktree',
        rename: '重命名',
        delete: '删除'
      },
      status: {
        archiving: '归档中',
        answering: '等待回答',
        commandApproval: '审批命令',
        permission: '等待授权',
        planning: '规划中',
        working: '执行中',
        planReady: '计划已就绪',
        ready: '就绪'
      },
      toasts: {
        attachmentRemoved: '附件已移除',
        attachmentRemoveError: '移除附件失败',
        invalidBranchName: '分支名称无效',
        branchRenamed: '分支已重命名为 {branch}',
        branchRenameError: '分支重命名失败',
        detachedCannotDuplicate: 'Detached HEAD 状态下的 worktree 不能复制',
        duplicatedTo: '已复制到 {name}',
        newBranch: '新分支',
        duplicateError: '复制 worktree 失败',
        archiveSuccess: 'Worktree “{name}” 已归档并删除分支',
        archiveError: '归档 worktree 失败：{error}',
        unbranchSuccess: 'Worktree “{name}” 已移除（保留分支）',
        removeWorktreeSuccess: 'Worktree “{name}” 已移除',
        unbranchError: '移除 worktree 失败：{error}',
        unknownError: '未知错误',
        openedInTerminal: '已在终端中打开',
        openInTerminalError: '在终端中打开失败',
        openInTerminalDescription: '请确认 worktree 目录存在',
        openedInEditor: '已在编辑器中打开',
        openInEditorError: '在编辑器中打开失败',
        openInEditorDescription: '请确认 VS Code 已安装',
        pathCopied: '路径已复制到剪贴板'
      }
    },
    projectItem: {
      menu: {
        editName: '编辑名称',
        openInFileManager: '在 {manager} 中打开',
        copyPath: '复制路径',
        refreshLanguage: '刷新语言识别',
        refreshProject: '刷新项目',
        newWorkspaceFrom: '从分支创建工作区...',
        projectSettings: '项目设置',
        assignToSpace: '分配到空间',
        removeFromHive: '从玄圃移除'
      },
      dialogs: {
        remove: {
          title: '要从玄圃移除这个项目吗？',
          description: '这会把 {name} 从玄圃移除。',
          unaffected: '磁盘上的文件不会受到影响。',
          cancel: '取消',
          confirm: '移除'
        },
        noCommits: {
          title: '需要先提交初始版本',
          description: '要创建 worktree，必须先创建一次初始提交。',
          ok: '好的'
        }
      },
      toasts: {
        renamedSuccess: '项目重命名成功',
        renamedError: '项目重命名失败',
        removedSuccess: '项目已从玄圃移除',
        removedError: '移除项目失败',
        pathCopied: '路径已复制到剪贴板',
        refreshed: '项目已刷新',
        worktreeCreated: 'Worktree “{name}” 创建成功',
        createWorktreeError: '创建 worktree 失败',
        createWorktreeErrorWithReason: '创建 worktree 失败：{error}',
        createWorktreeFromBranchError: '从分支创建 worktree 失败',
        createWorktreeFromBranchErrorWithReason: '从分支创建 worktree 失败：{error}'
      }
    }
  }
}
