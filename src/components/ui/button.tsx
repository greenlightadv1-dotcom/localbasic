import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded font-semibold transition-colors ' +
    'disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-primary select-none',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg hover:bg-primary/90 active:bg-primary',
        secondary: 'bg-primary-soft text-primary hover:bg-primary-soft/70',
        outline: 'border border-line bg-elevated text-fg hover:bg-surface',
        ghost: 'text-fg hover:bg-surface',
        danger: 'bg-danger text-white hover:bg-danger/90',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
        // POS and kitchen targets: large enough for a fingertip in a hurry.
        touch: 'h-16 px-6 text-lg',
        icon: 'h-10 w-10',
      },
      block: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(button({ variant, size, block }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
