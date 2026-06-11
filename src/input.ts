export class Input {
  enabled: boolean = true;
  sensitivity: number = 0.0022; // radians/px

  private _dx: number = 0;
  private _dy: number = 0;

  private _down    = new Set<string>();
  private _pressed = new Set<string>(); // set this frame, cleared in endFrame

  mouseDown:    boolean = false;
  mouse2Down:   boolean = false;
  mousePressed: boolean = false;
  mouse2Pressed: boolean = false;

  wheelDelta: number = 0;

  private _locked: boolean = false;
  onLockChange?: (locked: boolean) => void;

  private _el: HTMLElement;

  constructor(domElement: HTMLElement) {
    this._el = domElement;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      if (!this._down.has(e.code)) {
        this._pressed.add(e.code);
      }
      this._down.add(e.code);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this._down.delete(e.code);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.enabled) return;
      if (this._locked) {
        this._dx += e.movementX;
        this._dy += e.movementY;
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!this.enabled) return;
      if (e.button === 0) {
        this.mouseDown = true;
        this.mousePressed = true;
      } else if (e.button === 2) {
        this.mouse2Down = true;
        this.mouse2Pressed = true;
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.mouseDown = false;
      else if (e.button === 2) this.mouse2Down = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (!this.enabled) return;
      this.wheelDelta += e.deltaY;
    };

    const onContextMenu = (e: Event) => {
      e.preventDefault();
    };

    const onPointerLockChange = () => {
      const doc = document as Document & { pointerLockElement?: Element | null };
      this._locked = doc.pointerLockElement === domElement;
      this.onLockChange?.(this._locked);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    domElement.addEventListener('mousemove', onMouseMove);
    domElement.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    domElement.addEventListener('wheel', onWheel, { passive: true });
    domElement.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onPointerLockChange);
  }

  consumeMouseDelta(): { dx: number; dy: number } {
    const result = { dx: this._dx, dy: this._dy };
    this._dx = 0;
    this._dy = 0;
    return result;
  }

  isDown(code: string): boolean {
    return this._down.has(code);
  }

  wasPressed(code: string): boolean {
    return this._pressed.has(code);
  }

  endFrame(): void {
    this._pressed.clear();
    this.mousePressed  = false;
    this.mouse2Pressed = false;
    this.wheelDelta    = 0;
  }

  requestLock(): void {
    this._el.requestPointerLock();
  }

  get locked(): boolean {
    return this._locked;
  }
}
