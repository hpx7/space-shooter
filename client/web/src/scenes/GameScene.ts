import InputText from "phaser3-rex-plugins/plugins/inputtext";

import { TurretState } from "../../../../api/types";
import { SafeArea } from "../../../../shared/consts";
import { HathoraConnection } from "../../../.hathora/client";
import backgroundUrl from "../../assets/background.png";
import laserUrl from "../../assets/laser.png";
import shipUrl from "../../assets/ship.png";
import turretUrl from "../../assets/turret.png";
import { GAME_WIDTH, GAME_HEIGHT } from "../consts";
import { Event, eventsCenter } from "../events";
import { syncSprites } from "../utils";

import type { AnonymousUserData } from "../../../../api/base";

export class GameScene extends Phaser.Scene {
  private connection!: HathoraConnection;

  private shipSprite: Phaser.GameObjects.Sprite | undefined;

  private shipTurret?: Phaser.GameObjects.Image;
  private turretControls = { left: false, right: false };

  private projectileSprites: Map<number, Phaser.GameObjects.Sprite> = new Map();

  private safeContainer!: Phaser.GameObjects.Container;
  private localUser!: AnonymousUserData;

  constructor() {
    super("game");
  }

  preload() {
    this.load.image("background", backgroundUrl);
    this.load.image("laser", laserUrl);
    this.load.image("ship", shipUrl);
    this.load.image("turret", turretUrl);
  }

  init({ connection, user }: { connection: HathoraConnection; user: AnonymousUserData }) {
    this.connection = connection;
    this.localUser = user;

    connection.joinGame({});

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => eventsCenter.off(Event.Resized, this.handleResized));
    this.events.once(Phaser.Scenes.Events.DESTROY, () => eventsCenter.removeAllListeners());
  }

  create() {
    // NOTE: using 2x width/height so that it covers space when in a mobile resolution
    // that could be slightly bigger; 2x _should_ cover all the cases
    this.add.tileSprite(0, 0, GAME_WIDTH * 2, GAME_HEIGHT * 2, "background").setOrigin(0, 0);

    this.safeContainer = this.add.container();

    eventsCenter.on(Event.Resized, this.handleResized);

    this.scene.run("debug-scene", { safeContainer: this.safeContainer });
    this.scene.run("resize-scene");

    const roomCodeConfig: InputText.IConfig = {
      border: 10,
      text: `Room Code: ${this.connection.stateId}`,
      color: "black",
      fontFamily: "futura",
      readOnly: true,
    };
    const inputText = new InputText(this, GAME_WIDTH - 100, 20, 200, 50, roomCodeConfig).setScrollFactor(0);
    this.add.existing(inputText);

    let prevDragLoc = { x: -1, y: -1 };
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.isFirstPlayer()) {
        return;
      }

      if (pointer.isDown) {
        const p = this.safeContainer.pointToContainer(pointer) as Phaser.Math.Vector2;
        const { x, y } = p;
        if (x !== prevDragLoc.x || y !== prevDragLoc.y) {
          this.connection?.thrustTowards({ location: { x, y } });
        }
        prevDragLoc = { x, y };
      }
    });
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.isFirstPlayer()) {
        // ship controller
        const p = this.safeContainer.pointToContainer(pointer) as Phaser.Math.Vector2;
        const { x, y } = p;
        if (x !== prevDragLoc.x || y !== prevDragLoc.y) {
          this.connection?.thrustTowards({ location: { x, y } });
        }
        prevDragLoc = { x, y };
      } else {
        // turret controller
        if (!this.shipTurret) {
          return;
        }

        const { width } = this.scale;
        const middle = width * 0.5;
        if (pointer.x < middle) {
          this.connection?.setTurretState({ state: TurretState.MOVE_LEFT });
        } else if (pointer.x >= middle) {
          this.connection?.setTurretState({ state: TurretState.MOVE_RIGHT });
        }
      }
    });
    this.input.on("pointerup", () => {
      if (this.isFirstPlayer()) {
        if (prevDragLoc.x !== -1 || prevDragLoc.y !== -1) {
          this.connection?.thrustTowards({ location: undefined });
          prevDragLoc = { x: -1, y: -1 };
        }
      } else {
        this.connection?.setTurretState({ state: TurretState.IDLE });
      }
    });
    this.input.on("gameout", () => {
      if (!this.isFirstPlayer()) {
        return;
      }
      if (prevDragLoc.x !== -1 || prevDragLoc.y !== -1) {
        this.connection?.thrustTowards({ location: undefined });
        prevDragLoc = { x: -1, y: -1 };
      }
    });
  }

  update(): void {
    if (this.connection === undefined) {
      return;
    }
    const { playerShip: ship, projectiles, turret } = this.connection.state;

    if (this.shipSprite === undefined) {
      this.shipSprite = new Phaser.GameObjects.Sprite(this, ship.location.x, ship.location.y, "ship");
      this.shipSprite.setScale(0.5, 0.5);
      this.safeContainer.add(this.shipSprite);
      this.shipTurret = this.add
        .image(this.shipSprite.x, this.shipSprite.y, "turret")
        .setScale(0.6)
        .setOrigin(0.2, 0.5);
      this.safeContainer.add(this.shipTurret);
    }
    this.shipSprite.setRotation(ship.angle);
    this.shipSprite.setPosition(ship.location.x, ship.location.y);

    // turret
    if (this.shipTurret) {
      this.shipTurret.setPosition(this.shipSprite.x, this.shipSprite.y);
      this.shipTurret.rotation = turret.angle;
    }

    syncSprites(
      this.projectileSprites,
      new Map(projectiles.map((projectile) => [projectile.id, projectile])),
      (projectile) => {
        const sprite = new Phaser.GameObjects.Sprite(this, projectile.location.x, projectile.location.y, "laser");
        sprite.setScale(0.5, 0.5);
        this.safeContainer.add(sprite);
        if (this.shipTurret) {
          this.safeContainer.moveBelow(sprite, this.shipTurret);
        }

        return sprite;
      },
      (projectileSprite, projectile) =>
        projectileSprite.setRotation(projectile.angle).setPosition(projectile.location.x, projectile.location.y)
    );
  }

  private positionSafeContainer() {
    const { width, height } = this.scale;
    const x = (width - SafeArea.width) * 0.5;
    const y = (height - SafeArea.height) * 0.5;

    this.safeContainer.x = x;
    this.safeContainer.y = y;
  }

  private handleResized = () => {
    if (this.safeContainer !== undefined) {
      this.positionSafeContainer();
    }
  };

  private isFirstPlayer() {
    // can probably cache this unless 'players' changes
    const idx = this.connection.state.players.findIndex((pid) => pid === this.localUser.id);
    return idx === 0;
  }
}
