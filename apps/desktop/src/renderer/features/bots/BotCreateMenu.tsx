import { useState } from 'react';
import { Plus, Store, UserRoundPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { addBotProfileAndWait } from './botStore';
import { BotProfileDialog, type BotProfileDialogValue } from './BotProfileDialog';

const EMPTY_PROFILE: BotProfileDialogValue = {
  name: '',
  description: '',
  identitySource: '',
  avatar: '🤖',
  avatarColor: 'violet',
};

export function BotCreateMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);

  const createTeammate = async (value: BotProfileDialogValue) => {
    const bot = await addBotProfileAndWait({
      name: value.name,
      description: value.description,
      identitySource: value.identitySource,
      channel: 'local',
      userContextSource: '',
      avatar: value.avatar,
      avatarColor: value.avatarColor,
      skills: [],
    });
    navigate(`/bots/${bot.id}`);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={
              compact
                ? 'flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover'
                : 'flex h-7 w-7 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]'
            }
            aria-label={t('bots.add')}
          >
            <Plus size={compact ? 16 : 15} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="w-48 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)]"
        >
          <DropdownMenuItem
            onSelect={() => navigate('/bots/roster/examples')}
            className="gap-2 rounded-lg px-2.5 py-2 text-12 text-[var(--text-secondary)] focus:bg-[var(--surface-hover)] focus:text-[var(--text-primary)]"
          >
            <Store size={14} />
            {t('bots.createMenu.recruit')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDialogOpen(true)}
            className="gap-2 rounded-lg px-2.5 py-2 text-12 text-[var(--text-secondary)] focus:bg-[var(--surface-hover)] focus:text-[var(--text-primary)]"
          >
            <UserRoundPlus size={14} />
            {t('bots.createMenu.create')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BotProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        value={EMPTY_PROFILE}
        mode="create"
        onSave={createTeammate}
      />
    </>
  );
}
