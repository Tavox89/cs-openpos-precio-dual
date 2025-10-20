<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

if ( ! class_exists( 'CSFX_Access_Manager' ) ) {

class CSFX_Access_Manager {

    const TABLE = 'csfx_authorizers';
    const NOTICE_KEY = 'csfx_access_notice';
    const MAX_ACTIVE = 5;

    private static $instance = null;

    public static function instance() {
        if ( null === self::$instance ) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    public static function install() {
        global $wpdb;
        $table = self::table_name();
        $charset = $wpdb->get_charset_collate();
        $sql = "CREATE TABLE {$table} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id BIGINT UNSIGNED NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            secure_key_hash VARCHAR(128) NOT NULL DEFAULT '',
            secure_key_salt VARCHAR(32) NOT NULL DEFAULT '',
            secure_key_cipher TEXT NOT NULL,
            secure_key_iv VARCHAR(32) NOT NULL DEFAULT '',
            manual_key_hash VARCHAR(128) NOT NULL DEFAULT '',
            manual_key_salt VARCHAR(32) NOT NULL DEFAULT '',
            manual_key_cipher TEXT NOT NULL,
            manual_key_iv VARCHAR(32) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            expires_at DATETIME NULL DEFAULT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY user_id (user_id)
        ) {$charset};";
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        dbDelta( $sql );
    }

    public static function table_name() {
        global $wpdb;
        return $wpdb->prefix . self::TABLE;
    }

    private function __construct() {
        add_action( 'plugins_loaded', array( $this, 'ensure_table_exists' ), 5 );
        add_action( 'init', array( $this, 'maybe_expire_authorizers' ) );
        add_action( 'admin_menu', array( $this, 'register_admin_page' ), 50 );
        add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );

        add_action( 'admin_post_csfx_access_create', array( $this, 'handle_create' ) );
        add_action( 'admin_post_csfx_access_update', array( $this, 'handle_update' ) );
        add_action( 'admin_post_csfx_access_regenerate', array( $this, 'handle_regenerate' ) );
        add_action( 'admin_post_csfx_access_toggle', array( $this, 'handle_toggle' ) );
        add_action( 'admin_post_csfx_access_delete', array( $this, 'handle_delete' ) );

        add_action( 'wp_ajax_csfx_access_search_users', array( $this, 'ajax_search_users' ) );

        add_action( 'rest_api_init', array( $this, 'register_rest_routes' ) );
        add_filter( 'op_get_login_cashdrawer_data', array( $this, 'inject_access_snapshot' ), 60 );
        add_action( 'wp_footer', array( $this, 'print_access_inline_script' ), PHP_INT_MAX );
        add_action( 'admin_footer', array( $this, 'print_access_inline_script' ), PHP_INT_MAX );
        add_action( 'wp_print_footer_scripts', array( $this, 'print_access_inline_script' ), PHP_INT_MAX );
        add_action( 'admin_print_footer_scripts', array( $this, 'print_access_inline_script' ), PHP_INT_MAX );
        add_action( 'op_pos_page_after', array( $this, 'print_access_inline_script' ), PHP_INT_MAX );
    }

    public function register_admin_page() {
        if ( ! current_user_can( 'manage_options' ) ) {
            return;
        }
        add_submenu_page(
            'csfx-conf',
            __( 'Configuración de acceso', 'csfx' ),
            __( 'Configuración de acceso', 'csfx' ),
            'manage_options',
            'csfx-conf-access',
            array( $this, 'render_admin_page' )
        );
    }

    public function enqueue_admin_assets( $hook ) {
        if ( empty( $_GET['page'] ) || $_GET['page'] !== 'csfx-conf-access' ) { // phpcs:ignore WordPress.Security.NonceVerification
            return;
        }
        $base_url = plugin_dir_url( CSFX_PLUGIN_FILE );
        wp_enqueue_style( 'csfx-access-admin', $base_url . 'assets/admin/csfx-access.css', array(), CSFX_PLUGIN_VERSION );
        wp_enqueue_script( 'csfx-access-admin', $base_url . 'assets/admin/csfx-access.js', array(), CSFX_PLUGIN_VERSION, true );
    }

    public function ensure_table_exists() {
        global $wpdb;
        $table = self::table_name();
        $exists = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) );
        if ( $exists !== $table ) {
            self::install();
        }
    }

    public function render_admin_page() {
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_die( esc_html__( 'No tiene permisos para acceder.', 'csfx' ) );
        }

        $authorizers  = $this->get_authorizers();
        $active_count = 0;
        foreach ( $authorizers as $auth ) {
            if ( 'active' === $auth->status && ! $this->is_row_expired( $auth ) ) {
                $active_count++;
            }
        }

        $notice     = $this->consume_notice();
        $search_key = wp_create_nonce( 'csfx-access-search' );
        $endpoint   = rest_url( 'csfx/v1/access/validate' );
        ?>
        <div class="wrap csfx-access-wrap">
            <h1><?php esc_html_e( 'Configuración de acceso', 'csfx' ); ?></h1>
            <?php if ( $notice ) : ?>
                <div class="notice notice-<?php echo esc_attr( $notice['type'] ); ?> is-dismissible"><p><?php echo esc_html( $notice['message'] ); ?></p></div>
            <?php endif; ?>

            <p class="description"><?php esc_html_e( 'Administra los supervisores autorizados para validar descuentos personalizados dentro del POS.', 'csfx' ); ?></p>

            <div class="csfx-access-panels">
                <div class="csfx-card csfx-card--form">
                    <div class="csfx-card__header">
                        <h2 class="csfx-card__title"><?php esc_html_e( 'Agregar supervisor autorizado', 'csfx' ); ?></h2>
                    </div>
                    <div class="csfx-card__body">
                        <?php if ( $active_count >= self::MAX_ACTIVE ) : ?>
                            <p class="csfx-alert csfx-alert--warning">
                                <span class="csfx-alert__icon" aria-hidden="true">⚠️</span>
                                <?php esc_html_e( 'Has alcanzado el máximo de autorizados activos. Revoca alguno antes de registrar un nuevo supervisor.', 'csfx' ); ?>
                            </p>
                        <?php endif; ?>
                        <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="csfx-access-form">
                            <?php wp_nonce_field( 'csfx-access-create' ); ?>
                            <input type="hidden" name="action" value="csfx_access_create" />
                            <input type="hidden" name="user_id" value="" data-csfx-access-user-field />
                            <table class="form-table csfx-form-table">
                                <tr>
                                    <th scope="row"><label for="csfx-access-user-search"><?php esc_html_e( 'Supervisor', 'csfx' ); ?></label></th>
                                    <td>
                                        <input type="search" class="regular-text" id="csfx-access-user-search" name="user_search" placeholder="<?php esc_attr_e( 'Buscar por nombre o correo…', 'csfx' ); ?>" data-csfx-access-user-search data-nonce="<?php echo esc_attr( $search_key ); ?>" autocomplete="off" />
                                        <p class="description"><?php esc_html_e( 'Selecciona un usuario existente de WordPress.', 'csfx' ); ?></p>
                                        <div class="csfx-access-user-results" data-csfx-access-user-results></div>
                                    </td>
                                </tr>
                                <tr>
                                    <th scope="row"><label for="csfx-access-manual-key"><?php esc_html_e( 'Clave manual (opcional)', 'csfx' ); ?></label></th>
                                    <td>
                                        <input type="text" class="regular-text" id="csfx-access-manual-key" name="manual_key" maxlength="32" autocomplete="off" placeholder="<?php esc_attr_e( 'PIN o código del supervisor', 'csfx' ); ?>" />
                                        <p class="description"><?php esc_html_e( 'Úsala solo en emergencias. Si la dejas vacía se generará una clave segura automáticamente.', 'csfx' ); ?></p>
                                    </td>
                                </tr>
                                <tr>
                                    <th scope="row"><label for="csfx-access-expiration"><?php esc_html_e( 'Expiración (opcional)', 'csfx' ); ?></label></th>
                                    <td>
                                        <input type="date" id="csfx-access-expiration" name="expires_at" />
                                        <p class="description"><?php esc_html_e( 'Fecha en la que la autorización se revocará automáticamente.', 'csfx' ); ?></p>
                                    </td>
                                </tr>
                            </table>
                            <p class="submit">
                                <button type="submit" class="csfx-button csfx-button--primary" <?php disabled( $active_count >= self::MAX_ACTIVE ); ?>><?php esc_html_e( 'Registrar autorizado', 'csfx' ); ?></button>
                            </p>
                        </form>
                    </div>
                </div>

                <div class="csfx-card csfx-card--list">
                    <div class="csfx-card__header">
                        <div class="csfx-card__title-group">
                            <h2 class="csfx-card__title"><?php esc_html_e( 'Supervisores registrados', 'csfx' ); ?></h2>
                        </div>
                        <span class="csfx-badge csfx-badge--info"><?php printf( esc_html__( '%d activos', 'csfx' ), intval( $active_count ) ); ?></span>
                    </div>
                    <div class="csfx-card__body">
                        <?php if ( empty( $authorizers ) ) : ?>
                            <p class="csfx-card__empty"><?php esc_html_e( 'Aún no se han agregado supervisores autorizados.', 'csfx' ); ?></p>
                        <?php else : ?>
                            <div class="csfx-table" role="region" aria-live="polite">
                                <table class="csfx-table__table" role="grid">
                                    <thead>
                                        <tr>
                                            <th scope="col"><?php esc_html_e( 'Supervisor', 'csfx' ); ?></th>
                                            <th scope="col"><?php esc_html_e( 'Estado', 'csfx' ); ?></th>
                                            <th scope="col"><?php esc_html_e( 'Acciones', 'csfx' ); ?></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <?php foreach ( $authorizers as $auth ) :
                                            $user            = $this->get_user_summary( $auth->user_id );
                                            $secure_plain    = $this->decrypt_value( $auth->secure_key_cipher, $auth->secure_key_iv );
                                            $manual_plain    = $this->decrypt_value( $auth->manual_key_cipher, $auth->manual_key_iv );
                                            $is_expired      = $this->is_row_expired( $auth );
                                            $status_label    = $is_expired ? __( 'Expirada', 'csfx' ) : ( 'active' === $auth->status ? __( 'Activa', 'csfx' ) : __( 'Revocada', 'csfx' ) );
                                            $status_class    = $is_expired ? 'expired' : ( 'active' === $auth->status ? 'active' : 'inactive' );
                                            $qr_text         = $secure_plain ? $secure_plain : '';
                                            $qr_data         = $qr_text ? $this->get_qr_data_uri( $qr_text ) : '';
                                            $toggle_active   = ( 'active' === $auth->status && ! $is_expired );
                                            $toggle_label    = $toggle_active ? __( 'Revocar', 'csfx' ) : __( 'Activar', 'csfx' );
                                            $toggle_button   = $toggle_active ? 'csfx-button csfx-button--danger-outline' : 'csfx-button csfx-button--success';
                                            $toggle_title    = $toggle_active ? __( 'Revoca el acceso inmediato del supervisor.', 'csfx' ) : __( 'Restaura el acceso del supervisor a las validaciones.', 'csfx' );
                                            $expires_display = $auth->expires_at ? $this->format_datetime( $auth->expires_at ) : __( 'Sin vencimiento', 'csfx' );
                                            $expires_date    = $auth->expires_at ? gmdate( 'Y-m-d', strtotime( $auth->expires_at ) ) : '';
                                            $manual_status   = $manual_plain ? __( 'Clave manual activa', 'csfx' ) : __( 'Sin clave manual', 'csfx' );
                                            $row_payload     = array(
                                                'id'          => (int) $auth->id,
                                                'user'        => array(
                                                    'name'  => $user['name'],
                                                    'email' => $user['email'],
                                                ),
                                                'status'      => array(
                                                    'label' => $status_label,
                                                    'class' => $status_class,
                                                    'raw'   => $auth->status,
                                                ),
                                                'secure_key'  => $secure_plain,
                                                'manual_key'  => $manual_plain,
                                                'manual_hint' => $manual_status,
                                                'expires'     => array(
                                                    'date'    => $expires_date,
                                                    'display' => $expires_display,
                                                ),
                                                'updated'     => $auth->updated_at ? $this->format_datetime( $auth->updated_at ) : '',
                                                'qr'          => $qr_data,
                                                'nonce'       => array(
                                                    'update'     => wp_create_nonce( 'csfx-access-update-' . $auth->id ),
                                                    'regenerate' => wp_create_nonce( 'csfx-access-regenerate-' . $auth->id ),
                                                ),
                                            );
                                            ?>
                                            <tr>
                                                <td class="csfx-table__cell csfx-table__cell--user" data-title="<?php esc_attr_e( 'Supervisor', 'csfx' ); ?>">
                                                    <span class="csfx-table__primary"><?php echo esc_html( $user['name'] ); ?></span>
                                                    <span class="csfx-table__secondary"><?php echo esc_html( $user['email'] ); ?></span>
                                                </td>
                                                <td class="csfx-table__cell csfx-table__cell--status" data-title="<?php esc_attr_e( 'Estado', 'csfx' ); ?>">
                                                    <span class="csfx-status-badge csfx-status-badge--<?php echo esc_attr( $status_class ); ?>"><?php echo esc_html( $status_label ); ?></span>
                                                    <span class="csfx-table__hint"><?php echo esc_html( $manual_status ); ?></span>
                                                    <span class="csfx-table__hint"><?php echo esc_html( $expires_display ); ?></span>
                                                </td>
                                                <td class="csfx-table__cell csfx-table__cell--actions" data-title="<?php esc_attr_e( 'Acciones', 'csfx' ); ?>">
                                                    <button type="button" class="csfx-button csfx-button--primary" data-csfx-open-modal data-csfx-auth="<?php echo esc_attr( wp_json_encode( $row_payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) ); ?>" title="<?php esc_attr_e( 'Ver detalles del supervisor', 'csfx' ); ?>"><?php esc_html_e( 'Ver', 'csfx' ); ?></button>
                                                    <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="csfx-inline-form">
                                                        <?php wp_nonce_field( 'csfx-access-toggle-' . $auth->id ); ?>
                                                        <input type="hidden" name="action" value="csfx_access_toggle" />
                                                        <input type="hidden" name="id" value="<?php echo esc_attr( $auth->id ); ?>" />
                                                        <input type="hidden" name="toggle_to" value="<?php echo esc_attr( $toggle_active ? 'revoked' : 'active' ); ?>" />
                                                        <button type="submit" class="<?php echo esc_attr( $toggle_button ); ?>" title="<?php echo esc_attr( $toggle_title ); ?>"><?php echo esc_html( $toggle_label ); ?></button>
                                                    </form>
                                                    <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('<?php esc_attr_e( '¿Eliminar este autorizado?', 'csfx' ); ?>');" class="csfx-inline-form">
                                                        <?php wp_nonce_field( 'csfx-access-delete-' . $auth->id ); ?>
                                                        <input type="hidden" name="action" value="csfx_access_delete" />
                                                        <input type="hidden" name="id" value="<?php echo esc_attr( $auth->id ); ?>" />
                                                        <button type="submit" class="csfx-button csfx-button--danger" title="<?php esc_attr_e( 'Eliminar al supervisor y sus claves asociadas.', 'csfx' ); ?>"><?php esc_html_e( 'Eliminar', 'csfx' ); ?></button>
                                                    </form>
                                                </td>
                                            </tr>
                                        <?php endforeach; ?>
                                    </tbody>
                                </table>
                            </div>
                        <?php endif; ?>
                    </div>
                    <div class="csfx-card__footer">
                        <span class="csfx-card__footer-label"><?php esc_html_e( 'Endpoint de validación REST', 'csfx' ); ?></span>
                        <code class="csfx-code-block"><?php echo esc_html( $endpoint ); ?></code>
                    </div>
                </div>
            </div>

            <div class="csfx-access-modal csfx-modal" data-csfx-modal hidden>
                <div class="csfx-modal__backdrop" data-csfx-modal-close></div>
                <div class="csfx-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="csfx-access-modal-title">
                    <header class="csfx-modal__header">
                        <div class="csfx-modal__identity">
                            <h3 id="csfx-access-modal-title" data-csfx-modal-name></h3>
                            <div class="csfx-modal__email" data-csfx-modal-email></div>
                        </div>
                        <button type="button" class="csfx-modal__close" data-csfx-modal-close aria-label="<?php esc_attr_e( 'Cerrar', 'csfx' ); ?>">
                            <span aria-hidden="true">&times;</span>
                        </button>
                    </header>
                    <div class="csfx-modal__summary">
                        <span class="csfx-status-badge" data-csfx-modal-status></span>
                        <span class="csfx-modal__hint" data-csfx-modal-manual-note></span>
                        <span class="csfx-modal__hint" data-csfx-modal-expires-display></span>
                    </div>
                    <div class="csfx-access-modal__meta csfx-modal__meta" data-csfx-modal-updated-label="<?php esc_attr_e( 'Última actualización:', 'csfx' ); ?>">
                        <span data-csfx-modal-updated></span>
                    </div>
                    <div class="csfx-modal__body">
                        <section class="csfx-modal-section">
                            <h4><?php esc_html_e( 'Clave segura', 'csfx' ); ?></h4>
                            <div class="csfx-modal-secure">
                                <code class="csfx-code-block csfx-code-block--contrast" data-csfx-modal-secure></code>
                                <button type="button" class="csfx-button csfx-button--ghost csfx-button--icon" data-csfx-copy="secure" title="<?php esc_attr_e( 'Copiar clave segura al portapapeles', 'csfx' ); ?>">
                                    <svg class="csfx-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true">
                                        <path d="M6 2.75h9.25a2 2 0 0 1 2 2V14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M4.75 6H11a2 2 0 0 1 2 2v7.25a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    <span><?php esc_html_e( 'Copiar', 'csfx' ); ?></span>
                                </button>
                            </div>
                            <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" data-csfx-modal-form="regenerate" class="csfx-modal-inline-form">
                                <input type="hidden" name="action" value="csfx_access_regenerate" />
                                <input type="hidden" name="id" value="" data-csfx-modal-field="id-regenerate" />
                                <input type="hidden" name="_wpnonce" value="" data-csfx-modal-field="nonce-regenerate" />
                                <button type="submit" class="csfx-button csfx-button--primary csfx-button--block"><?php esc_html_e( 'Regenerar clave segura', 'csfx' ); ?></button>
                            </form>
                        </section>
                        <section class="csfx-modal-section">
                            <h4><?php esc_html_e( 'Clave manual', 'csfx' ); ?></h4>
                            <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" data-csfx-modal-form="manual" class="csfx-modal-form">
                                <input type="hidden" name="action" value="csfx_access_update" />
                                <input type="hidden" name="id" value="" data-csfx-modal-field="id-manual" />
                                <input type="hidden" name="_wpnonce" value="" data-csfx-modal-field="nonce-update" />
                                <label class="csfx-modal-field">
                                    <span class="csfx-modal-field__label"><?php esc_html_e( 'PIN o código del supervisor', 'csfx' ); ?></span>
                                    <input type="text" name="manual_key" maxlength="32" autocomplete="off" placeholder="<?php esc_attr_e( 'PIN o código del supervisor', 'csfx' ); ?>" data-csfx-modal-input="manual" />
                                </label>
                                <div class="csfx-modal-actions">
                                    <button type="submit" class="csfx-button csfx-button--primary"><?php esc_html_e( 'Guardar cambios', 'csfx' ); ?></button>
                                    <button type="button" class="csfx-button csfx-button--subtle csfx-button--danger-text" data-csfx-clear-manual title="<?php esc_attr_e( 'Eliminará la clave manual al guardar.', 'csfx' ); ?>"><?php esc_html_e( 'Eliminar clave manual', 'csfx' ); ?></button>
                                </div>
                                <p class="csfx-modal-note"><?php esc_html_e( 'Deja el campo vacío y guarda para eliminar la clave manual.', 'csfx' ); ?></p>
                            </form>
                        </section>
                        <section class="csfx-modal-section">
                            <h4><?php esc_html_e( 'Expiración', 'csfx' ); ?></h4>
                            <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" data-csfx-modal-form="expires" class="csfx-modal-inline-form">
                                <input type="hidden" name="action" value="csfx_access_update" />
                                <input type="hidden" name="id" value="" data-csfx-modal-field="id-expires" />
                                <input type="hidden" name="_wpnonce" value="" data-csfx-modal-field="nonce-update-2" />
                                <label class="csfx-modal-field csfx-modal-field--inline">
                                    <span class="csfx-modal-field__label"><?php esc_html_e( 'Fecha de vencimiento', 'csfx' ); ?></span>
                                    <input type="date" name="expires_at" data-csfx-modal-input="expires" />
                                </label>
                                <div class="csfx-modal-actions">
                                    <button type="submit" class="csfx-button csfx-button--primary"><?php esc_html_e( 'Actualizar', 'csfx' ); ?></button>
                                    <button type="button" class="csfx-button csfx-button--subtle" data-csfx-clear-expiry title="<?php esc_attr_e( 'Quita la fecha de vencimiento para mantener el acceso indefinido.', 'csfx' ); ?>"><?php esc_html_e( 'Quitar vencimiento', 'csfx' ); ?></button>
                                </div>
                            </form>
                        </section>
                        <section class="csfx-modal-section">
                            <h4><?php esc_html_e( 'QR del supervisor', 'csfx' ); ?></h4>
                            <div class="csfx-modal-qr">
                                <div class="csfx-modal-qr__preview">
                                    <img src="" alt="" data-csfx-modal-qr />
                                </div>
                                <a href="#" class="csfx-button csfx-button--outline csfx-button--icon csfx-modal-qr__download" data-csfx-modal-download aria-disabled="true" tabindex="-1" data-available="0">
                                    <svg class="csfx-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true">
                                        <path d="M10 3.5v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M6.75 9.75 10 12.75l3.25-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M4.5 15.25h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                                    </svg>
                                    <span><?php esc_html_e( 'Descargar QR', 'csfx' ); ?></span>
                                </a>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
        <?php
    }

    public function handle_create() {
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_die( esc_html__( 'Acceso denegado.', 'csfx' ) );
        }
        check_admin_referer( 'csfx-access-create' );

        $user_id   = isset( $_POST['user_id'] ) ? absint( $_POST['user_id'] ) : 0;
        $manual    = isset( $_POST['manual_key'] ) ? $this->sanitize_key_input( sanitize_text_field( wp_unslash( $_POST['manual_key'] ) ) ) : '';
        $expires   = isset( $_POST['expires_at'] ) ? sanitize_text_field( wp_unslash( $_POST['expires_at'] ) ) : '';

        if ( ! $user_id || ! get_userdata( $user_id ) ) {
            $this->flash_notice( 'error', __( 'Debes seleccionar un usuario válido.', 'csfx' ) );
            $this->redirect_back();
        }

        if ( $this->authorizer_exists( $user_id ) ) {
            $this->flash_notice( 'error', __( 'Este usuario ya cuenta con una autorización activa o pendiente.', 'csfx' ) );
            $this->redirect_back();
        }

        if ( $this->count_active_authorizers() >= self::MAX_ACTIVE ) {
            $this->flash_notice( 'error', __( 'Has alcanzado el máximo de autorizados activos.', 'csfx' ) );
            $this->redirect_back();
        }

        $secure_key = $this->generate_secure_key();
        $manual_key = $manual ? $manual : '';
        $expires_at = $expires ? gmdate( 'Y-m-d 23:59:59', strtotime( $expires ) ) : null;

        $created = $this->insert_authorizer( $user_id, $secure_key, $manual_key, $expires_at );
        if ( ! $created ) {
            $this->flash_notice( 'error', __( 'No se pudo crear la autorización.', 'csfx' ) );
            $this->redirect_back();
        }

        $user = $this->get_user_summary( $user_id );
        $this->flash_notice( 'success', sprintf( __( 'Supervisor %s registrado. Clave segura: %s', 'csfx' ), $user['name'], $secure_key ) );
        $this->log_event( 'Autorizado creado', array( 'user_id' => $user_id ) );
        $this->redirect_back();
    }

    public function handle_update() {
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_die( esc_html__( 'Acceso denegado.', 'csfx' ) );
        }
        $id = isset( $_POST['id'] ) ? absint( $_POST['id'] ) : 0;
        check_admin_referer( 'csfx-access-update-' . $id );

        $row = $this->get_authorizer( $id );
        if ( ! $row ) {
            $this->flash_notice( 'error', __( 'Autorizado no encontrado.', 'csfx' ) );
            $this->redirect_back();
        }

        $data = array();

        if ( array_key_exists( 'manual_key', $_POST ) ) {
            $manual = isset( $_POST['manual_key'] ) ? $this->sanitize_key_input( sanitize_text_field( wp_unslash( $_POST['manual_key'] ) ) ) : '';
            if ( '' === $manual ) {
                $data['manual_key_hash']  = '';
                $data['manual_key_salt']  = '';
                $data['manual_key_cipher'] = '';
                $data['manual_key_iv']    = '';
            } else {
                $manual_storage           = $this->prepare_key_storage( $manual );
                $data['manual_key_hash']  = $manual_storage['hash'];
                $data['manual_key_salt']  = $manual_storage['salt'];
                $data['manual_key_cipher'] = $manual_storage['cipher'];
                $data['manual_key_iv']    = $manual_storage['iv'];
            }
        }

        if ( array_key_exists( 'expires_at', $_POST ) ) {
            $expires = isset( $_POST['expires_at'] ) ? sanitize_text_field( wp_unslash( $_POST['expires_at'] ) ) : '';
            $data['expires_at'] = $expires ? gmdate( 'Y-m-d 23:59:59', strtotime( $expires ) ) : null;
        }

        if ( empty( $data ) ) {
            $this->flash_notice( 'info', __( 'No hay cambios que guardar.', 'csfx' ) );
            $this->redirect_back();
        }

        $data['updated_at'] = current_time( 'mysql', true );
        $saved              = $this->update_authorizer( $id, $data );

        if ( $saved ) {
            $this->flash_notice( 'success', __( 'Información actualizada.', 'csfx' ) );
        } else {
            $this->flash_notice( 'error', __( 'No se pudo actualizar.', 'csfx' ) );
        }
        $this->redirect_back();
    }

    public function handle_regenerate() {
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_die( esc_html__( 'Acceso denegado.', 'csfx' ) );
        }
        $id = isset( $_POST['id'] ) ? absint( $_POST['id'] ) : 0;
        check_admin_referer( 'csfx-access-regenerate-' . $id );

        $row = $this->get_authorizer( $id );
        if ( ! $row ) {
            $this->flash_notice( 'error', __( 'Autorizado no encontrado.', 'csfx' ) );
            $this->redirect_back();
        }

        $secure_key = $this->generate_secure_key();
        $storage    = $this->prepare_key_storage( $secure_key );
        $data       = array(
            'secure_key_hash'   => $storage['hash'],
            'secure_key_salt'   => $storage['salt'],
            'secure_key_cipher' => $storage['cipher'],
            'secure_key_iv'     => $storage['iv'],
            'updated_at'        => current_time( 'mysql', true ),
        );

        $saved = $this->update_authorizer( $id, $data );
        if ( $saved ) {
            $user = $this->get_user_summary( $row->user_id );
            $this->flash_notice( 'success', sprintf( __( 'Nueva clave para %s: %s', 'csfx' ), $user['name'], $secure_key ) );
            $this->log_event( 'Clave regenerada', array( 'user_id' => $row->user_id ) );
        } else {
            $this->flash_notice( 'error', __( 'No se pudo regenerar la clave.', 'csfx' ) );
        }
        $this->redirect_back();
    }

    public function handle_toggle() {
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_die( esc_html__( 'Acceso denegado.', 'csfx' ) );
        }
        $id        = isset( $_POST['id'] ) ? absint( $_POST['id'] ) : 0;
        $toggle_to = isset( $_POST['toggle_to'] ) ? sanitize_text_field( wp_unslash( $_POST['toggle_to'] ) ) : '';
        check_admin_referer( 'csfx-access-toggle-' . $id );

        if ( ! in_array( $toggle_to, array( 'active', 'revoked' ), true ) ) {
            $this->flash_notice( 'error', __( 'Estado no válido.', 'csfx' ) );
            $this->redirect_back();
        }

        $row = $this->get_authorizer( $id );
        if ( ! $row ) {
            $this->flash_notice( 'error', __( 'Autorizado no encontrado.', 'csfx' ) );
            $this->redirect_back();
        }

        if ( 'active' === $toggle_to && $this->count_active_authorizers() >= self::MAX_ACTIVE && 'active' !== $row->status ) {
            $this->flash_notice( 'error', __( 'No puedes activar más de cinco autorizados simultáneamente.', 'csfx' ) );
            $this->redirect_back();
        }

        $updated = $this->update_authorizer( $id, array(
            'status'     => $toggle_to,
            'updated_at' => current_time( 'mysql', true ),
        ) );

        if ( $updated ) {
            $this->flash_notice( 'success', __( 'Estado actualizado.', 'csfx' ) );
        } else {
            $this->flash_notice( 'error', __( 'No se pudo actualizar el estado.', 'csfx' ) );
        }
        $this->redirect_back();
    }

    public function handle_delete() {
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_die( esc_html__( 'Acceso denegado.', 'csfx' ) );
        }
        $id = isset( $_POST['id'] ) ? absint( $_POST['id'] ) : 0;
        check_admin_referer( 'csfx-access-delete-' . $id );

        $deleted = $this->delete_authorizer( $id );
        if ( $deleted ) {
            $this->flash_notice( 'success', __( 'Autorizado eliminado.', 'csfx' ) );
        } else {
            $this->flash_notice( 'error', __( 'No se pudo eliminar.', 'csfx' ) );
        }
        $this->redirect_back();
    }

    public function ajax_search_users() {
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_send_json_error();
        }
        check_ajax_referer( 'csfx-access-search' );

        $term  = isset( $_GET['term'] ) ? sanitize_text_field( wp_unslash( $_GET['term'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
        $items = array();

        if ( strlen( $term ) >= 2 ) {
            $users = get_users( array(
                'search'         => '*' . esc_attr( $term ) . '*',
                'search_columns' => array( 'user_login', 'user_email', 'display_name' ),
                'number'         => 10,
            ) );
            foreach ( $users as $user ) {
                $items[] = array(
                    'id'    => (int) $user->ID,
                    'label' => sprintf( '%s (%s)', $user->display_name, $user->user_email ),
                );
            }
        }

        wp_send_json( array( 'items' => $items ) );
    }

    public function register_rest_routes() {
        register_rest_route( 'csfx/v1', '/access/validate', array(
            'methods'             => WP_REST_Server::CREATABLE,
            'callback'            => array( $this, 'rest_validate_access' ),
            'permission_callback' => '__return_true',
        ) );
    }

    public function rest_validate_access( WP_REST_Request $request ) {
        $key = trim( (string) $request->get_param( 'key' ) );
        if ( '' === $key ) {
            return new WP_REST_Response( array( 'valid' => false, 'reason' => 'empty' ), 400 );
        }

        $match = $this->match_pin( $key );
        $data  = array( 'valid' => false );

        if ( $match ) {
            $user = $this->get_user_summary( $match->user_id );
            $data['valid'] = true;
            $data['user']  = array(
                'id'    => (int) $match->user_id,
                'name'  => $user['name'],
                'email' => $user['email'],
            );
        }

        if ( defined( 'CS_FX_DEBUG' ) && CS_FX_DEBUG ) {
            $this->log_event(
                'Validación REST de PIN',
                array(
                    'result'         => $match ? 'valid' : 'invalid',
                    'user_id'        => $match ? (int) $match->user_id : 0,
                    'pin_fingerprint'=> hash( 'sha256', 'debug|' . $key ),
                )
            );
        }

        if ( $request->get_param( 'snapshot' ) ) {
            $data['snapshot'] = $this->get_access_snapshot();
        }

        return rest_ensure_response( $data );
    }

    public function inject_access_snapshot( $session ) {
        $snapshot = $this->get_access_snapshot();
        if ( ! isset( $session['setting']['cs_fx'] ) || ! is_array( $session['setting']['cs_fx'] ) ) {
            $session['setting']['cs_fx'] = array();
        }
        $session['setting']['cs_fx']['accessSnapshot'] = $snapshot;
        $session['setting']['cs_fx']['accessEndpoint'] = rest_url( 'csfx/v1/access/validate' );
        return $session;
    }

    public function print_access_inline_script() {
        static $printed = false;
        if ( $printed ) {
            return;
        }
        $printed = true;
        $snapshot = $this->get_access_snapshot();
        $payload  = wp_json_encode( $snapshot, JSON_UNESCAPED_SLASHES );
        $endpoint = esc_url_raw( rest_url( 'csfx/v1/access/validate' ) );
        ?>
        <script>
        window.__CS_FX_ACCESS = <?php echo $payload ? $payload : 'null'; ?>;
        window.CSFX_ACCESS_ENDPOINT = <?php echo wp_json_encode( $endpoint, JSON_UNESCAPED_SLASHES ); ?>;
        if (typeof window.CSFX_ACCESS_DEBUG === 'undefined') {
          window.CSFX_ACCESS_DEBUG = <?php echo CS_FX_DEBUG ? 'true' : 'false'; ?>;
        }
        (function(){
          if (typeof window === 'undefined') return;
          var snapshot = window.__CS_FX_ACCESS || {};
          var storageKey = 'csfx_access_snapshot';
          var debugSeed = <?php echo CS_FX_DEBUG ? 'true' : 'false'; ?>;

          function debugLog() {
            var enabled = debugSeed;
            if (typeof window.CSFX_ACCESS_DEBUG !== 'undefined') {
              enabled = !!window.CSFX_ACCESS_DEBUG;
            } else if (!enabled && typeof window.CSFX_DEBUG !== 'undefined') {
              enabled = !!window.CSFX_DEBUG;
            }
            if (!enabled) {
              return;
            }
            try {
              if (arguments.length === 1) {
                console.log(arguments[0]);
              } else {
                console.log.apply(console, arguments);
              }
            } catch (err) {}
          }

          function loadSnapshot(){
            try {
              var raw = localStorage.getItem(storageKey);
              if (!raw) return {};
              return JSON.parse(raw);
            } catch (err) {
              return {};
            }
          }

          function persistSnapshot(data){
            if (!data || typeof data !== 'object') return;
            try {
              localStorage.setItem(storageKey, JSON.stringify(data));
            } catch (err) {}
          }

          var supervisorStorageKey = 'csfx_last_supervisor';

          function loadSupervisorRecord(){
            try {
              var raw = null;
              if (typeof sessionStorage !== 'undefined') {
                raw = sessionStorage.getItem(supervisorStorageKey);
              }
              if (!raw && typeof localStorage !== 'undefined') {
                raw = localStorage.getItem(supervisorStorageKey);
              }
              if (!raw) return null;
              return JSON.parse(raw);
            } catch (err) {
              return null;
            }
          }

          function persistSupervisorRecord(record){
            if (!record || typeof record !== 'object') return;
            window.CSFX_LAST_SUPERVISOR = record;
            try {
              if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem(supervisorStorageKey, JSON.stringify(record));
              }
            } catch (errSess) {}
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem(supervisorStorageKey, JSON.stringify(record));
              }
            } catch (errLocal) {}
            try {
              document.dispatchEvent(new CustomEvent('csfx:supervisor-authorized', { detail: { supervisor: record } }));
            } catch (errEvt) {}
          }

          function buildSupervisorRecord(entry, context){
            context = context || {};
            var source = entry || context.user || {};
            if (!source || typeof source !== 'object') return null;
            var record = {
              id: typeof source.user_id !== 'undefined' ? source.user_id : (typeof source.id !== 'undefined' ? source.id : null),
              name: source.user_name || source.user || source.name || '',
              email: source.user_email || source.email || '',
              via: context.via || 'local',
              method: context.method || '',
              authorized_at: new Date().toISOString()
            };
            if (typeof source.expires_at !== 'undefined' && source.expires_at) {
              record.expires_at = source.expires_at;
            }
            return record;
          }

          var storedSupervisor = loadSupervisorRecord();
          if (storedSupervisor) {
            window.CSFX_LAST_SUPERVISOR = storedSupervisor;
          }

          debugLog('[CSFX Access] Inline script bootstrap', snapshot);

          if (!snapshot || !snapshot.list || !snapshot.list.length) {
            var stored = loadSnapshot();
            if (stored && stored.list) {
              snapshot = stored;
              window.__CS_FX_ACCESS = snapshot;
            }
          } else {
            persistSnapshot(snapshot);
          }

          function normalizePin(value){
            return String(value || '').replace(/\s+/g, '');
          }

          function sha256(ascii){
            function rightRotate(value, amount){
              return (value>>>amount) | (value<<(32-amount));
            }

            var mathPow = Math.pow;
            var maxWord = mathPow(2, 32);
            var lengthProperty = 'length';
            var i, j; var result = '';

            var words = [];
            var asciiBitLength = ascii[lengthProperty]*8;

            var hash = sha256.h = sha256.h || [];
            var k = sha256.k = sha256.k || [];
            var primeCounter = k[lengthProperty];

            var isComposite = {};
            for (var candidate = 2; primeCounter < 64; candidate++) {
              if (!isComposite[candidate]) {
                for (i = 0; i < 313; i += candidate) {
                  isComposite[i] = candidate;
                }
                hash[primeCounter] = (mathPow(candidate, .5)*maxWord)|0;
                k[primeCounter++] = (mathPow(candidate, 1/3)*maxWord)|0;
              }
            }

            ascii += '\x80';
            while (ascii[lengthProperty]%64 - 56) ascii += '\x00';
            for (i = 0; i < ascii[lengthProperty]; i++) {
              j = ascii.charCodeAt(i);
              if (j>>8) return; // ASCII check
              words[i>>2] |= j << ((3 - i)%4)*8;
            }
            words[words[lengthProperty]] = ((asciiBitLength/maxWord)|0);
            words[words[lengthProperty]] = (asciiBitLength);

            for (j = 0; j < words[lengthProperty];) {
              var w = words.slice(j, j += 16);
              var oldHash = hash;
              hash = hash.slice(0, 8);

              for (i = 0; i < 64; i++) {
                var w15 = w[i - 15], w2 = w[i - 2];

                var a = hash[0], e = hash[4];
                var temp1 = hash[7]
                  + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
                  + ((e & hash[5]) ^ ((~e) & hash[6]))
                  + k[i]
                  + (w[i] = (i < 16) ? w[i] : (
                      w[i - 16]
                      + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15>>>3))
                      + w[i - 7]
                      + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2>>>10))
                    )|0
                    );

                var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
                  + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));

                hash = [(temp1 + temp2)|0].concat(hash);
                hash[4] = (hash[4] + temp1)|0;
              }

              for (i = 0; i < 8; i++) {
                hash[i] = (hash[i] + oldHash[i])|0;
              }
            }

            for (i = 0; i < 8; i++) {
              for (j = 3; j + 1; j--) {
                var b = (hash[i] >> (j*8)) & 255;
                result += ((b < 16) ? 0 : '') + b.toString(16);
              }
            }
            return result;
          }

          function computeHash(entry, pin){
            if (!entry || !entry.secure_salt) return null;
            return sha256(entry.secure_salt + '|' + pin);
          }

          function computeManual(entry, pin){
            if (!entry || !entry.manual_salt) return null;
            return sha256(entry.manual_salt + '|' + pin);
          }

          function isExpired(entry){
            if (!entry || !entry.expires_at) return false;
            return (Date.now() / 1000) > entry.expires_at;
          }

          function findLocal(pin){
            if (!snapshot || !snapshot.list) return null;
            var normalized = normalizePin(pin);
            for (var i = 0; i < snapshot.list.length; i++) {
              var entry = snapshot.list[i];
              if (!entry || entry.status !== 'active') continue;
              if (isExpired(entry)) continue;
              var computedSecure = entry.secure_hash ? computeHash(entry, normalized) : null;
              var computedManual = entry.manual_hash ? computeManual(entry, normalized) : null;
              debugLog('[CSFX Access] Comparación local', {
                entryId: entry.id || entry.user_id || i,
                pinIngresado: pin,
                pinNormalizado: normalized,
                secureSalt: entry.secure_salt || null,
                computedSecure: computedSecure,
                expectedSecure: entry.secure_hash || null,
                manualSalt: entry.manual_salt || null,
                computedManual: computedManual,
                expectedManual: entry.manual_hash || null
              });
              if (entry.secure_hash && computedSecure === entry.secure_hash) {
                return { entry: entry, method: 'secure', normalized: normalized };
              }
              if (entry.manual_hash && computedManual === entry.manual_hash) {
                return { entry: entry, method: 'manual', normalized: normalized };
              }
            }
            return null;
          }

          document.addEventListener('csfx:validate-custom-discount-pin', function(ev){
            if (!ev || !ev.detail) return;
            var detail = ev.detail;
            var pin = detail.pin || '';
            if (!pin) return;
            var normalizedPin = normalizePin(pin);
            detail.handled = true;
            detail.pinNormalized = normalizedPin;
            debugLog('[CSFX Access] PIN recibido', pin);
            if (pin !== normalizedPin) {
              debugLog('[CSFX Access] PIN normalizado', normalizedPin);
            }
            debugLog('[CSFX Access] Snapshot actual', snapshot && snapshot.list ? snapshot.list : snapshot);

            Promise.resolve().then(function(){
              var localMatch = findLocal(normalizedPin);
              if (localMatch && localMatch.entry) {
                debugLog('[CSFX Access] PIN validado localmente', localMatch.entry);
                var localRecord = buildSupervisorRecord(localMatch.entry, {
                  via: 'local',
                  method: localMatch.method || ''
                });
                if (localRecord) {
                  persistSupervisorRecord(localRecord);
                }
                detail.respond(true);
                return;
              }
              if (!window.CSFX_ACCESS_ENDPOINT) {
                debugLog('[CSFX Access] Endpoint REST no configurado.');
                detail.respond(false);
                return;
              }
              return fetch(window.CSFX_ACCESS_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: normalizedPin, snapshot: true }),
                credentials: 'same-origin'
              }).then(function(res){
                debugLog('[CSFX Access] Respuesta REST status', res.status);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
              }).then(function(json){
                debugLog('[CSFX Access] Payload REST', json);
                if (json && json.snapshot && json.snapshot.list) {
                  snapshot = json.snapshot;
                  window.__CS_FX_ACCESS = snapshot;
                  persistSnapshot(snapshot);
                  debugLog('[CSFX Access] Snapshot actualizado desde REST', snapshot.list);
                }
                var isValid = !!(json && json.valid);
                debugLog('[CSFX Access] Resultado de validación REST', isValid);
                if (isValid) {
                  var remoteSource = null;
                  if (json.user && typeof json.user === 'object') {
                    remoteSource = {
                      user_id: json.user.id,
                      user_name: json.user.name,
                      user_email: json.user.email,
                      expires_at: null
                    };
                  }
                  if (!remoteSource && snapshot && Array.isArray(snapshot.list)) {
                    for (var j = 0; j < snapshot.list.length; j++) {
                      var candidate = snapshot.list[j];
                      if (candidate && candidate.user_id) {
                        remoteSource = candidate;
                        break;
                      }
                    }
                  }
                  var remoteRecord = buildSupervisorRecord(remoteSource, { via: 'remote', method: (json && json.method) ? json.method : 'remote' });
                  if (remoteRecord) {
                    persistSupervisorRecord(remoteRecord);
                  }
                }
                detail.respond(isValid);
              }).catch(function(){
                debugLog('[CSFX Access] Error durante validación REST');
                detail.respond(false);
              });
            });
          });
        })();
        </script>
        <?php
    }

    public function maybe_expire_authorizers() {
        global $wpdb;
        $table = self::table_name();
        $now   = current_time( 'mysql', true );
        $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET status = 'revoked', updated_at = %s WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < %s", $now, $now ) );
    }

    /* === Data helpers === */

    private function get_authorizers() {
        global $wpdb;
        $table = self::table_name();
        return $wpdb->get_results( "SELECT * FROM {$table} ORDER BY created_at DESC" );
    }

    private function get_authorizer( $id ) {
        global $wpdb;
        $table = self::table_name();
        return $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $id ) );
    }

    private function authorizer_exists( $user_id ) {
        global $wpdb;
        $table = self::table_name();
        $exists = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$table} WHERE user_id = %d LIMIT 1", $user_id ) );
        return ! empty( $exists );
    }

    private function count_active_authorizers() {
        global $wpdb;
        $table = self::table_name();
        $now   = current_time( 'mysql', true );
        return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$table} WHERE status = 'active' AND (expires_at IS NULL OR expires_at >= %s)", $now ) );
    }

    private function insert_authorizer( $user_id, $secure_key, $manual_key, $expires_at ) {
        global $wpdb;
        $table = self::table_name();

        $secure = $this->prepare_key_storage( $secure_key );
        $manual = $manual_key ? $this->prepare_key_storage( $manual_key ) : null;

        $data = array(
            'user_id'           => $user_id,
            'status'            => 'active',
            'secure_key_hash'   => $secure['hash'],
            'secure_key_salt'   => $secure['salt'],
            'secure_key_cipher' => $secure['cipher'],
            'secure_key_iv'     => $secure['iv'],
            'manual_key_hash'   => $manual ? $manual['hash'] : '',
            'manual_key_salt'   => $manual ? $manual['salt'] : '',
            'manual_key_cipher' => $manual ? $manual['cipher'] : '',
            'manual_key_iv'     => $manual ? $manual['iv'] : '',
            'created_at'        => current_time( 'mysql', true ),
            'updated_at'        => current_time( 'mysql', true ),
            'expires_at'        => $expires_at,
        );

        $inserted = $wpdb->insert( $table, $data );
        return $inserted ? (int) $wpdb->insert_id : 0;
    }

    private function update_authorizer( $id, $data ) {
        if ( empty( $data ) ) {
            return false;
        }
        global $wpdb;
        $table = self::table_name();
        return false !== $wpdb->update( $table, $data, array( 'id' => $id ), null, array( '%d' ) );
    }

    private function delete_authorizer( $id ) {
        global $wpdb;
        $table = self::table_name();
        return false !== $wpdb->delete( $table, array( 'id' => $id ), array( '%d' ) );
    }

    private function generate_secure_key() {
        return strtoupper( wp_generate_password( 12, false, false ) );
    }

    private function sanitize_key_input( $key ) {
        return preg_replace( '/\s+/', '', trim( $key ) );
    }

    private function prepare_key_storage( $plain ) {
        $plain = $this->sanitize_key_input( $plain );
        $salt  = wp_generate_password( 16, false, false );
        $hash  = hash( 'sha256', $salt . '|' . $plain );
        $enc   = $this->encrypt_value( $plain );

        return array(
            'hash'   => $hash,
            'salt'   => $salt,
            'cipher' => $enc['cipher'],
            'iv'     => $enc['iv'],
        );
    }

    private function encrypt_value( $value ) {
        if ( '' === $value ) {
            return array( 'cipher' => '', 'iv' => '' );
        }
        $key = substr( $this->get_encryption_key(), 0, 32 );
        if ( ! function_exists( 'openssl_encrypt' ) ) {
            return array(
                'cipher' => base64_encode( $value ),
                'iv'     => '',
            );
        }
        $iv     = substr( hash( 'sha256', wp_generate_password( 32, false, false ) ), 0, 16 );
        $cipher = openssl_encrypt( $value, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv );
        if ( false === $cipher ) {
            return array(
                'cipher' => base64_encode( $value ),
                'iv'     => '',
            );
        }
        return array(
            'cipher' => base64_encode( $cipher ),
            'iv'     => base64_encode( $iv ),
        );
    }

    private function decrypt_value( $cipher, $iv ) {
        if ( '' === $cipher ) {
            return '';
        }
        $key = substr( $this->get_encryption_key(), 0, 32 );
        $raw = base64_decode( $cipher );
        if ( ! function_exists( 'openssl_decrypt' ) || '' === $iv ) {
            return $raw !== false ? $raw : '';
        }
        $iv_raw = base64_decode( $iv );
        if ( false === $iv_raw ) {
            return $raw !== false ? $raw : '';
        }
        $plain = openssl_decrypt( $raw, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv_raw );
        return false === $plain ? '' : $plain;
    }

    private function get_encryption_key() {
        $salt = AUTH_KEY . SECURE_AUTH_KEY . NONCE_KEY;
        return hash( 'sha256', $salt );
    }

    private function get_qr_data_uri( $text ) {
        if ( '' === $text ) {
            return '';
        }
        if ( ! class_exists( '\\CSFX_QR\\QRcode' ) ) {
            require_once plugin_dir_path( CSFX_PLUGIN_FILE ) . 'includes/lib/phpqrcode.php';
        }
        ob_start();
        \CSFX_QR\QRcode::png( $text, null, QR_ECLEVEL_L, 4, 1 );
        $image = ob_get_clean();
        if ( ! $image ) {
            return '';
        }
        return 'data:image/png;base64,' . base64_encode( $image );
    }

    private function match_pin( $pin ) {
        $pin = $this->sanitize_key_input( $pin );
        if ( '' === $pin ) {
            return null;
        }
        $rows = $this->get_authorizers();
        foreach ( $rows as $row ) {
            if ( 'active' !== $row->status ) {
                continue;
            }
            if ( $this->is_row_expired( $row ) ) {
                continue;
            }
            $secure_plain = $this->decrypt_value( $row->secure_key_cipher, $row->secure_key_iv );
            $secure_hash_match = $this->compare_hash( $row->secure_key_hash, $row->secure_key_salt, $pin );
            if ( $secure_hash_match || ( $secure_plain && hash_equals( $secure_plain, $pin ) ) ) {
                return $row;
            }
            $manual_plain       = '';
            $manual_hash_match  = false;
            if ( $row->manual_key_hash || $row->manual_key_cipher ) {
                $manual_plain = $this->decrypt_value( $row->manual_key_cipher, $row->manual_key_iv );
                $manual_hash_match = $this->compare_hash( $row->manual_key_hash, $row->manual_key_salt, $pin );
                if ( $manual_hash_match || ( $manual_plain && hash_equals( $manual_plain, $pin ) ) ) {
                    return $row;
                }
            }
            if ( defined( 'CS_FX_DEBUG' ) && CS_FX_DEBUG ) {
                $this->log_event(
                    'Comparación PIN sin coincidencia',
                    array(
                        'row_id'            => (int) $row->id,
                        'status'            => $row->status,
                        'expired'           => $this->is_row_expired( $row ),
                        'secure_hash_match' => $secure_hash_match,
                        'has_secure_plain'  => $secure_plain !== '',
                        'manual_hash_match' => $manual_hash_match,
                        'has_manual_plain'  => $manual_plain !== '',
                        'pin_fingerprint'   => substr( hash( 'sha256', 'debug|' . $pin ), 0, 16 ),
                    )
                );
            }
        }
        return null;
    }

    private function compare_hash( $hash, $salt, $pin ) {
        if ( ! $hash || ! $salt ) {
            return false;
        }
        return hash( 'sha256', $salt . '|' . $pin ) === $hash;
    }

    public function get_access_snapshot() {
        $rows = $this->get_authorizers();
        $list = array();
        foreach ( $rows as $row ) {
            $user         = $this->get_user_summary( $row->user_id );
            $status       = $this->is_row_expired( $row ) ? 'expired' : $row->status;
            $expires_ts   = $row->expires_at ? strtotime( $row->expires_at . ' UTC' ) : null;
            $secure_plain = $this->decrypt_value( $row->secure_key_cipher, $row->secure_key_iv );
            $manual_plain = $this->decrypt_value( $row->manual_key_cipher, $row->manual_key_iv );

            $secure_salt = $row->secure_key_salt ? $row->secure_key_salt : '';
            $manual_salt = $row->manual_key_salt ? $row->manual_key_salt : '';

            $secure_hash = $row->secure_key_hash ? $row->secure_key_hash : '';
            $manual_hash = $row->manual_key_hash ? $row->manual_key_hash : '';

            $needs_update = false;
            $update_data  = array();

            if ( $secure_plain ) {
                if ( '' === $secure_salt ) {
                    $secure_salt = wp_generate_password( 16, false, false );
                    $update_data['secure_key_salt'] = $secure_salt;
                    $needs_update = true;
                }

                $computed_secure_hash = hash( 'sha256', $secure_salt . '|' . $secure_plain );
                if ( $computed_secure_hash !== $secure_hash ) {
                    $secure_hash = $computed_secure_hash;
                    $update_data['secure_key_hash'] = $secure_hash;
                    $needs_update = true;
                }
            } else {
                if ( $secure_salt || $secure_hash ) {
                    $update_data['secure_key_salt'] = '';
                    $update_data['secure_key_hash'] = '';
                    $needs_update = true;
                }
                $secure_salt = '';
                $secure_hash = '';
            }

            if ( $manual_plain ) {
                if ( '' === $manual_salt ) {
                    $manual_salt = wp_generate_password( 16, false, false );
                    $update_data['manual_key_salt'] = $manual_salt;
                    $needs_update = true;
                }

                $computed_manual_hash = hash( 'sha256', $manual_salt . '|' . $manual_plain );
                if ( $computed_manual_hash !== $manual_hash ) {
                    $manual_hash = $computed_manual_hash;
                    $update_data['manual_key_hash'] = $manual_hash;
                    $needs_update = true;
                }
            } else {
                if ( $manual_salt || $manual_hash ) {
                    $update_data['manual_key_salt'] = '';
                    $update_data['manual_key_hash'] = '';
                    $needs_update = true;
                }
                $manual_salt = '';
                $manual_hash = '';
            }

            if ( $needs_update ) {
                $update_data['updated_at'] = current_time( 'mysql', true );
                $this->update_authorizer( $row->id, $update_data );
            }

            $list[] = array(
                'id'           => (int) $row->id,
                'user_id'      => (int) $row->user_id,
                'user_name'    => $user['name'],
                'user_email'   => $user['email'],
                'secure_hash'  => $secure_hash,
                'secure_salt'  => $secure_salt,
                'manual_hash'  => $manual_hash,
                'manual_salt'  => $manual_salt,
                'status'       => $status,
                'expires_at'   => $expires_ts ? (int) $expires_ts : null,
                'updated_at'   => $row->updated_at ? strtotime( $row->updated_at . ' UTC' ) : null,
            );
        }

        return array(
            'list'      => $list,
            'generated' => time(),
            'version'   => 1,
        );
    }

    private function get_user_summary( $user_id ) {
        $user = get_userdata( $user_id );
        if ( ! $user ) {
            return array(
                'name'  => __( 'Usuario no encontrado', 'csfx' ),
                'email' => ''
            );
        }
        return array(
            'name'  => $user->display_name,
            'email' => $user->user_email,
        );
    }

    private function is_row_expired( $row ) {
        if ( empty( $row->expires_at ) ) {
            return false;
        }
        return strtotime( $row->expires_at ) < current_time( 'timestamp', true );
    }

    private function format_datetime( $datetime ) {
        if ( ! $datetime ) {
            return '';
        }
        $timestamp = strtotime( $datetime . ' UTC' );
        $formatted = wp_date( 'Y-m-d H:i', $timestamp );
        return $formatted;
    }

    private function log_event( $message, $context = array() ) {
        if ( ! function_exists( 'wc_get_logger' ) ) {
            return;
        }
        $logger = wc_get_logger();
        $logger->info( $message, array_merge( array( 'source' => 'csfx-access' ), $context ) );
    }

    private function flash_notice( $type, $message ) {
        $key = self::NOTICE_KEY . '_' . get_current_user_id();
        set_transient( $key, array(
            'type'    => $type,
            'message' => $message,
        ), 45 );
    }

    private function consume_notice() {
        $key = self::NOTICE_KEY . '_' . get_current_user_id();
        $notice = get_transient( $key );
        if ( $notice ) {
            delete_transient( $key );
        }
        return $notice;
    }

    private function redirect_back() {
        $url = add_query_arg( array( 'page' => 'csfx-conf-access' ), admin_url( 'admin.php' ) );
        wp_safe_redirect( $url );
        exit;
    }
}

}
