/** Classic menu bar behaviour: click to open, hover to switch, click an item or outside to close. */
export function setupMenus(menubar: HTMLElement) {
  const menus = [...menubar.querySelectorAll<HTMLElement>(':scope > .menu')];
  let open: HTMLElement | null = null;

  const close = () => {
    open?.classList.remove('open');
    open = null;
  };
  const show = (menu: HTMLElement) => {
    close();
    menu.classList.add('open');
    open = menu;
  };

  for (const menu of menus) {
    const title = menu.querySelector<HTMLElement>('.menu-title')!;
    title.addEventListener('click', () => (open === menu ? close() : show(menu)));
    title.addEventListener('pointerenter', () => {
      if (open && open !== menu) show(menu);
    });
  }

  document.addEventListener('pointerdown', (e) => {
    if (open && !open.contains(e.target as Node)) close();
  });
  menubar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.menu-pop button[data-cmd]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return { close };
}
