import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { BRAND_CLAIM, BRAND_NAME, useBranding } from '@/lib/brand';
import { ShelterFrog } from './ShelterFrog';
import { useI18n } from '@/i18n';

interface BrandProps {
  compact?: boolean;
  inverse?: boolean;
  linkTo?: string;
  showClaim?: boolean;
}

export function Brand({ compact = false, inverse = false, linkTo = '/', showClaim = false }: BrandProps) {
  const { t } = useI18n();
  const { profile } = useBranding();
  const light = profile.logoLight ?? profile.icon ?? profile.logoDark;
  const dark = profile.logoDark ?? light;
  const wordmark = profile.logoLayout === 'wordmark' && Boolean(light) && !compact;
  return (
    <Link
      className={cn(
        'group inline-flex w-fit items-center gap-2.5 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        inverse ? 'text-sidebar-foreground' : 'text-foreground',
      )}
      to={linkTo}
      aria-label={t('Shelter home', 'Shelter Startseite')}
    >
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-[0.7rem] transition-transform group-hover:-translate-y-px',
          compact && 'size-7',
          wordmark && 'w-32',
        )}
        aria-hidden="true"
      >
        {light ? <>
          <img src={light} alt="" className="size-full object-contain dark:hidden" />
          <img src={dark ?? light} alt="" className="hidden size-full object-contain dark:block" />
        </> : <ShelterFrog className="size-full drop-shadow-sm" />}
      </span>
      {!compact && !wordmark && (
        <span className="grid gap-0.5 leading-none">
          <span className="text-2xl font-semibold tracking-[-0.05em]">{BRAND_NAME}</span>
          {showClaim && <span className="text-[0.65rem] font-medium tracking-[0.06em] text-muted-foreground">{BRAND_CLAIM}</span>}
        </span>
      )}
    </Link>
  );
}
