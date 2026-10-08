/** XP notification balloons and simple modal dialogs. */
export class Notifier {
  private readonly balloon = document.getElementById('balloon')!;
  private readonly modal = document.getElementById('modal') as HTMLDialogElement;
  private timer = 0;

  constructor() {
    this.balloon.querySelector('.balloon-close')!.addEventListener('click', () => this.hideBalloon());
    this.modal.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-close]')) this.modal.close();
    });
  }

  /** Shows a balloon pointing at `anchor` (above it when there is room, otherwise below). */
  showBalloon(anchor: Element, title: string, text: string, seconds = 6) {
    const b = this.balloon;
    b.querySelector('#balloon-title')!.textContent = title;
    b.querySelector('#balloon-text')!.textContent = text;
    b.hidden = false;
    b.classList.remove('below');

    const r = anchor.getBoundingClientRect();
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const anchorX = r.left + r.width / 2;
    const left = Math.min(Math.max(anchorX - 30, 8), window.innerWidth - bw - 8);
    let top = r.top - bh - 14;
    if (top < 8) {
      top = r.bottom + 14;
      b.classList.add('below');
    }
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
    b.style.setProperty('--tail-x', `${Math.min(Math.max(anchorX - left - 6, 12), bw - 24)}px`);

    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hideBalloon(), seconds * 1000);
  }

  hideBalloon() {
    this.balloon.hidden = true;
  }

  showModal(title: string, body: Node | string) {
    this.modal.querySelector('#modal-title')!.textContent = title;
    const host = this.modal.querySelector('#modal-body')!;
    host.replaceChildren();
    if (typeof body === 'string') host.innerHTML = body;
    else host.append(body);
    if (!this.modal.open) this.modal.showModal();
  }

  closeModal() {
    if (this.modal.open) this.modal.close();
  }
}
