import { useBranding } from '@/lib/brand';
import type { ImgHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type ShelterFrogProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'height' | 'src' | 'width'> & {
  title?: string;
};

export function ShelterFrog({ className, title, ...props }: ShelterFrogProps) {
  const { profile, revision } = useBranding();
  return (
    <img
      src={profile.icon ?? profile.logoLight ?? profile.logoDark ?? (profile.name === "Shelter" ? "/brand/shelter-icon-64.png" : `/api/branding/assets/icon?v=${revision}`)}
      width="64"
      height="64"
      alt={title ?? ''}
      className={cn('size-6', className)}
      aria-hidden={title ? undefined : true}
      draggable={false}
      {...props}
    />
  );
}
