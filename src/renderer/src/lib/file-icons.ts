import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderOpen,
  Lock,
  Package,
  Settings,
  BookOpen,
  Container,
  Terminal,
  type LucideIcon
} from 'lucide-react'

/**
 * Demo4-style colored text labels for language/code files.
 * Each extension maps to a short abbreviation and a Tailwind color class.
 */
export const textLabelMap: Record<string, { label: string; colorClass: string }> = {
  // TypeScript
  '.ts': { label: 'TS', colorClass: 'text-blue-500' },
  '.mts': { label: 'TS', colorClass: 'text-blue-500' },
  '.cts': { label: 'TS', colorClass: 'text-blue-500' },

  // React (TSX/JSX)
  '.tsx': { label: 'TX', colorClass: 'text-blue-400' },
  '.jsx': { label: 'JX', colorClass: 'text-yellow-400' },

  // JavaScript
  '.js': { label: 'JS', colorClass: 'text-yellow-500' },
  '.mjs': { label: 'JS', colorClass: 'text-yellow-500' },
  '.cjs': { label: 'JS', colorClass: 'text-yellow-500' },

  // Python
  '.py': { label: 'Py', colorClass: 'text-sky-500' },
  '.pyi': { label: 'Py', colorClass: 'text-sky-500' },
  '.pyx': { label: 'Py', colorClass: 'text-sky-500' },

  // Go
  '.go': { label: 'Go', colorClass: 'text-cyan-500' },

  // Rust
  '.rs': { label: 'Rs', colorClass: 'text-orange-500' },

  // Swift
  '.swift': { label: 'Sw', colorClass: 'text-orange-400' },

  // Java
  '.java': { label: 'Jv', colorClass: 'text-red-500' },

  // Kotlin
  '.kt': { label: 'Kt', colorClass: 'text-violet-500' },
  '.kts': { label: 'Kt', colorClass: 'text-violet-500' },

  // C
  '.c': { label: 'C', colorClass: 'text-gray-500' },
  '.h': { label: 'H', colorClass: 'text-gray-500' },

  // C++
  '.cpp': { label: 'C+', colorClass: 'text-blue-600' },
  '.hpp': { label: 'H+', colorClass: 'text-blue-600' },
  '.cc': { label: 'C+', colorClass: 'text-blue-600' },
  '.cxx': { label: 'C+', colorClass: 'text-blue-600' },

  // C#
  '.cs': { label: 'C#', colorClass: 'text-green-500' },

  // Ruby
  '.rb': { label: 'Rb', colorClass: 'text-red-500' },
  '.erb': { label: 'Rb', colorClass: 'text-red-500' },

  // PHP
  '.php': { label: 'PH', colorClass: 'text-indigo-400' },

  // Dart
  '.dart': { label: 'Dt', colorClass: 'text-teal-400' },

  // YAML
  '.yaml': { label: 'YM', colorClass: 'text-rose-400' },
  '.yml': { label: 'YM', colorClass: 'text-rose-400' },

  // TOML
  '.toml': { label: 'TL', colorClass: 'text-orange-400' },

  // Markdown
  '.md': { label: 'MD', colorClass: 'text-blue-400' },
  '.mdx': { label: 'MX', colorClass: 'text-blue-400' },

  // HTML
  '.html': { label: 'HT', colorClass: 'text-orange-500' },
  '.htm': { label: 'HT', colorClass: 'text-orange-500' },

  // CSS
  '.css': { label: 'CS', colorClass: 'text-blue-500' },

  // Sass/SCSS/Less
  '.scss': { label: 'SC', colorClass: 'text-pink-500' },
  '.sass': { label: 'SA', colorClass: 'text-pink-500' },
  '.less': { label: 'LS', colorClass: 'text-pink-500' },

  // Vue
  '.vue': { label: 'Vu', colorClass: 'text-green-500' },

  // Svelte
  '.svelte': { label: 'Sv', colorClass: 'text-orange-600' },

  // JSON
  '.json': { label: 'JN', colorClass: 'text-amber-500' },
  '.jsonc': { label: 'JN', colorClass: 'text-amber-500' },
  '.json5': { label: 'JN', colorClass: 'text-amber-500' },

  // GraphQL
  '.graphql': { label: 'GQ', colorClass: 'text-pink-500' },
  '.graphqls': { label: 'GQ', colorClass: 'text-pink-500' },
  '.gql': { label: 'GQ', colorClass: 'text-pink-500' },

  // Lua
  '.lua': { label: 'Lu', colorClass: 'text-blue-600' },

  // R
  '.r': { label: 'R', colorClass: 'text-blue-500' },

  // Scala
  '.scala': { label: 'Sc', colorClass: 'text-red-500' },
  '.sc': { label: 'Sc', colorClass: 'text-red-500' },

  // Zig
  '.zig': { label: 'Zg', colorClass: 'text-orange-400' },

  // Elixir
  '.ex': { label: 'Ex', colorClass: 'text-purple-500' },
  '.exs': { label: 'Ex', colorClass: 'text-purple-500' },

  // Astro
  '.astro': { label: 'As', colorClass: 'text-orange-500' },

  // Shell
  '.sh': { label: 'SH', colorClass: 'text-green-600' },
  '.bash': { label: 'SH', colorClass: 'text-green-600' },
  '.zsh': { label: 'SH', colorClass: 'text-green-600' },
  '.fish': { label: 'SH', colorClass: 'text-green-600' },
  '.ps1': { label: 'PS', colorClass: 'text-blue-500' },
  '.bat': { label: 'BT', colorClass: 'text-gray-500' },
  '.cmd': { label: 'CM', colorClass: 'text-gray-500' },

  // SQL
  '.sql': { label: 'SQ', colorClass: 'text-blue-400' },
  '.sqlite': { label: 'SQ', colorClass: 'text-blue-400' },

  // XML
  '.xml': { label: 'XM', colorClass: 'text-orange-400' },
  '.xsl': { label: 'XM', colorClass: 'text-orange-400' },
  '.xslt': { label: 'XM', colorClass: 'text-orange-400' },

  // Haskell
  '.hs': { label: 'Hs', colorClass: 'text-purple-500' },
  '.lhs': { label: 'Hs', colorClass: 'text-purple-500' },

  // Erlang
  '.erl': { label: 'Er', colorClass: 'text-red-400' },
  '.hrl': { label: 'Er', colorClass: 'text-red-400' },

  // Clojure
  '.clj': { label: 'Cl', colorClass: 'text-green-500' },
  '.cljs': { label: 'Cl', colorClass: 'text-green-500' },
  '.cljc': { label: 'Cl', colorClass: 'text-green-500' },
  '.edn': { label: 'Cl', colorClass: 'text-green-500' },

  // Perl
  '.pl': { label: 'Pl', colorClass: 'text-blue-400' },
  '.pm': { label: 'Pl', colorClass: 'text-blue-400' }
}

/** Maps extensions to lucide icon + color for non-language file types */
export const lucideFallbackMap: Record<string, { icon: LucideIcon; color: string }> = {
  // Images
  '.png': { icon: FileImage, color: 'text-green-500' },
  '.jpg': { icon: FileImage, color: 'text-green-500' },
  '.jpeg': { icon: FileImage, color: 'text-green-500' },
  '.gif': { icon: FileImage, color: 'text-green-500' },
  '.svg': { icon: FileImage, color: 'text-green-500' },
  '.webp': { icon: FileImage, color: 'text-green-500' },
  '.ico': { icon: FileImage, color: 'text-green-500' },
  '.bmp': { icon: FileImage, color: 'text-green-500' },

  // Video
  '.mp4': { icon: FileVideo, color: 'text-purple-500' },
  '.webm': { icon: FileVideo, color: 'text-purple-500' },
  '.avi': { icon: FileVideo, color: 'text-purple-500' },
  '.mov': { icon: FileVideo, color: 'text-purple-500' },
  '.mkv': { icon: FileVideo, color: 'text-purple-500' },

  // Audio
  '.mp3': { icon: FileAudio, color: 'text-pink-500' },
  '.wav': { icon: FileAudio, color: 'text-pink-500' },
  '.ogg': { icon: FileAudio, color: 'text-pink-500' },
  '.flac': { icon: FileAudio, color: 'text-pink-500' },

  // Archives
  '.zip': { icon: FileArchive, color: 'text-orange-400' },
  '.tar': { icon: FileArchive, color: 'text-orange-400' },
  '.gz': { icon: FileArchive, color: 'text-orange-400' },
  '.bz2': { icon: FileArchive, color: 'text-orange-400' },
  '.7z': { icon: FileArchive, color: 'text-orange-400' },
  '.rar': { icon: FileArchive, color: 'text-orange-400' },

  // Fonts
  '.ttf': { icon: FileType, color: 'text-red-400' },
  '.otf': { icon: FileType, color: 'text-red-400' },
  '.woff': { icon: FileType, color: 'text-red-400' },
  '.woff2': { icon: FileType, color: 'text-red-400' },
  '.eot': { icon: FileType, color: 'text-red-400' },

  // Documentation
  '.pdf': { icon: BookOpen, color: 'text-red-500' },
  '.doc': { icon: BookOpen, color: 'text-blue-500' },
  '.docx': { icon: BookOpen, color: 'text-blue-500' },

  // Config (no language text label)
  '.ini': { icon: Settings, color: 'text-gray-500' },
  '.styl': { icon: Settings, color: 'text-pink-500' },
  '.stylus': { icon: Settings, color: 'text-pink-500' },
  '.db': { icon: Settings, color: 'text-blue-400' },

  // Env
  '.env': { icon: Lock, color: 'text-yellow-600' },

  // Text
  '.txt': { icon: FileText, color: 'text-gray-400' },
  '.rtf': { icon: FileText, color: 'text-gray-400' }
}

interface SpecialFileEntry {
  lucide?: LucideIcon
  color?: string
}

/**
 * Maps special filenames (lowercase) to lucide icon info.
 * All keys are lowercase — lookup normalizes via toLowerCase().
 */
export const specialFileMap: Record<string, SpecialFileEntry> = {
  'package.json': { lucide: Package, color: 'text-green-600' },
  'package-lock.json': { lucide: Lock, color: 'text-yellow-600' },
  'pnpm-lock.yaml': { lucide: Lock, color: 'text-yellow-600' },
  'yarn.lock': { lucide: Lock, color: 'text-yellow-600' },
  'bun.lockb': { lucide: Lock, color: 'text-yellow-600' },
  dockerfile: { lucide: Container, color: 'text-blue-500' },
  'docker-compose.yml': { lucide: Container, color: 'text-blue-500' },
  'docker-compose.yaml': { lucide: Container, color: 'text-blue-500' },
  '.dockerignore': { lucide: Settings, color: 'text-muted-foreground' },
  makefile: { lucide: Terminal, color: 'text-green-600' },
  'tsconfig.json': { lucide: Settings, color: 'text-blue-500' },
  'jsconfig.json': { lucide: Settings, color: 'text-yellow-500' },
  '.eslintrc': { lucide: Settings, color: 'text-purple-500' },
  '.eslintrc.js': { lucide: Settings, color: 'text-purple-500' },
  '.eslintrc.json': { lucide: Settings, color: 'text-purple-500' },
  '.eslintrc.cjs': { lucide: Settings, color: 'text-purple-500' },
  'eslint.config.js': { lucide: Settings, color: 'text-purple-500' },
  'eslint.config.mjs': { lucide: Settings, color: 'text-purple-500' },
  '.prettierrc': { lucide: Settings, color: 'text-pink-500' },
  '.prettierrc.js': { lucide: Settings, color: 'text-pink-500' },
  '.prettierrc.json': { lucide: Settings, color: 'text-pink-500' },
  '.gitignore': { lucide: Settings, color: 'text-orange-500' },
  '.gitattributes': { lucide: Settings, color: 'text-orange-500' },
  '.editorconfig': { lucide: Settings, color: 'text-muted-foreground' },
  license: { lucide: FileText, color: 'text-gray-400' },
  '.env': { lucide: Lock, color: 'text-yellow-600' },
  '.env.local': { lucide: Lock, color: 'text-yellow-600' },
  '.env.development': { lucide: Lock, color: 'text-yellow-600' },
  '.env.production': { lucide: Lock, color: 'text-yellow-600' },
  '.env.test': { lucide: Lock, color: 'text-yellow-600' }
}

export type FileIconInfo =
  | { type: 'text'; label: string; colorClass: string }
  | { type: 'lucide'; icon: LucideIcon; colorClass: string }

/** Resolves a special file entry to a FileIconInfo, or null if entry is empty */
function resolveSpecial(entry: SpecialFileEntry): FileIconInfo | null {
  if (entry.lucide) {
    return {
      type: 'lucide',
      icon: entry.lucide,
      colorClass: entry.color ?? 'text-muted-foreground'
    }
  }
  return null
}

/**
 * Determines the appropriate icon for a file based on its name, extension, and type.
 * Returns either a colored text label or a lucide icon with color class.
 */
export function getFileIconInfo(
  name: string,
  extension: string | null,
  isDirectory: boolean,
  isExpanded?: boolean
): FileIconInfo {
  // Directories
  if (isDirectory) {
    return {
      type: 'lucide',
      icon: isExpanded ? FolderOpen : Folder,
      colorClass: 'text-amber-600 dark:text-amber-300'
    }
  }

  // Normalize for case-insensitive lookups
  const lowerName = name.toLowerCase()
  const ext = extension?.toLowerCase() ?? null

  // Check special file names (all keys stored lowercase)
  const special = specialFileMap[lowerName]
  if (special) {
    const resolved = resolveSpecial(special)
    if (resolved) return resolved
  }

  // Check .env* pattern (covers .env.anything)
  if (lowerName.startsWith('.env')) {
    return {
      type: 'lucide',
      icon: Lock,
      colorClass: 'text-yellow-600'
    }
  }

  // Check text label by extension (language/code files)
  if (ext) {
    const textLabel = textLabelMap[ext]
    if (textLabel) return { type: 'text', ...textLabel }

    // Check lucide fallback by extension (media, archives, etc.)
    const fallback = lucideFallbackMap[ext]
    if (fallback) {
      return {
        type: 'lucide',
        icon: fallback.icon,
        colorClass: fallback.color
      }
    }
  }

  // Default fallback
  return {
    type: 'lucide',
    icon: File,
    colorClass: 'text-muted-foreground'
  }
}
