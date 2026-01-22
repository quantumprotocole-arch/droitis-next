'use client'

import React from 'react'

const WORDS_LEFT = [
  'RESPONSABILITÉ CIVILE',
  'PROCÉDURE CIVILE',
  'PRESCRIPTION',
  'FORCE MAJEURE',
  'NULLITÉ ABSOLUE',
  'MANDAT',
  'ACTE AUTHENTIQUE',
  'EXÉCUTION PROVISOIRE',
  'LITIGE',
]

const WORDS_RIGHT = [
  'SÛRETÉ',
  'LIEN DE CAUSALITÉ',
  'RÉSILIATION',
  'INDIVISION',
  'SERVITUDE',
  'CLAUSE PÉNALE',
  'SUBROGATION',
  'DOMMAGES-INTÉRÊTS',
  'PRÉSOMPTION',
]

function WordColumn({ words, className }: { words: string[]; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="droitis-words-row">
          {words.map((w) => (
            <span key={`${i}-${w}`} className="droitis-word">
              {w}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Background Droitis:
 * - Dégradé pastel rose → bleu
 * - Mots juridiques en arrière-plan (faible opacité)
 */
export default function BrandBackground({
  children,
  className = '',
  variant = 'auth',
}: {
  children?: React.ReactNode
  className?: string
  variant?: 'auth' | 'app'
}) {
  return (
    <div className={`relative min-h-dvh w-full overflow-hidden ${className}`}>
      <div className="absolute inset-0 bg-droitis-gradient" aria-hidden="true" />

      {/* Legal words */}
      <div className="absolute inset-0" aria-hidden="true">
        <WordColumn
          words={WORDS_LEFT}
          className="absolute -left-12 top-0 h-full w-[55%] -rotate-2 opacity-55"
        />
        <WordColumn
          words={WORDS_RIGHT}
          className="absolute -right-12 top-0 h-full w-[55%] rotate-2 opacity-55 text-right"
        />
      </div>

      {/* Readability overlay */}
      <div
        className={[
          'absolute inset-0',
          variant === 'auth' ? 'bg-white/10 backdrop-blur-[1px]' : 'bg-black/5',
        ].join(' ')}
        aria-hidden="true"
      />

      <div className="relative">{children}</div>
    </div>
  )
}
